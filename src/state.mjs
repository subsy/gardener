/**
 * ABOUTME: Code-state snapshot of one commit: size, large files, type escapes, lint
 * suppressions, test weight and (when configured) SQL function size and redefinitions.
 * Reads blobs straight from git, so the same commit always yields the same numbers.
 */
import { classifiers, looksGenerated } from './config.mjs';
import {
  commitTime,
  lineCount,
  listBlobs,
  readBlobs,
  revParse,
} from './git.mjs';

const TOP = 10;

const countMatches = (text, re) => {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n += 1;
  return n;
};

const compile = (map) =>
  Object.entries(map).map(([name, source]) => [name, new RegExp(source, 'gm')]);

const topBy = (items, key) =>
  [...items].sort((a, b) => b[key] - a[key]).slice(0, TOP);

/** Snapshot of `rev`, from `cache` when it has one; `rev` must be a full SHA. */
export function cachedSnapshot(cache, cwd, rev, config) {
  const hit = cache.get(rev);
  if (hit) return hit;
  const state = snapshot(cwd, rev, config);
  cache.set(rev, state);
  return state;
}

/** Measures the commit `rev` under `config`. */
export function snapshot(cwd, rev, config) {
  const sha = revParse(cwd, rev);
  const is = classifiers(config);
  const blobs = listBlobs(cwd, sha);
  const code = blobs.filter((b) => is.isCode(b.path));
  const sql = blobs.filter(
    (b) =>
      !is.ignored(b.path) && (is.isSchema(b.path) || is.isMigration(b.path)),
  );
  const contents = readBlobs(
    cwd,
    [...code, ...sql].map((b) => b.oid),
  );

  const escapes = compile(config.patterns.typeEscapes);
  const suppressions = compile(config.patterns.suppressions);
  const testRes = {
    cases: new RegExp(config.patterns.testCases, 'gm'),
    mockModules: new RegExp(config.patterns.mockModules, 'gm'),
    callAssertions: new RegExp(config.patterns.callAssertions, 'gm'),
    assertions: new RegExp(config.patterns.assertions, 'gm'),
  };

  const zero = (pairs) => Object.fromEntries(pairs.map(([name]) => [name, 0]));
  const state = {
    commit: sha,
    time: commitTime(cwd, sha),
    files: { source: 0, test: 0, generatedSkipped: 0 },
    lines: { source: 0, test: 0 },
    largeFiles: {
      threshold: config.largeFileLines,
      count: 0,
      lines: 0,
      top: [],
    },
    typeEscapes: { source: zero(escapes), test: zero(escapes) },
    suppressions: { source: zero(suppressions), test: zero(suppressions) },
    tests: { cases: 0, mockModules: 0, callAssertions: 0, assertions: 0 },
    sql: null,
  };
  const large = [];

  code.forEach((blob, i) => {
    const buf = contents[i];
    const head = buf.toString('utf8', 0, Math.min(buf.length, 600));
    if (looksGenerated(head)) {
      state.files.generatedSkipped += 1;
      return;
    }
    const text = buf.toString('utf8');
    const lines = lineCount(buf);
    const kind = is.isTest(blob.path) ? 'test' : 'source';
    state.files[kind] += 1;
    state.lines[kind] += lines;
    for (const [name, re] of escapes)
      state.typeEscapes[kind][name] += countMatches(text, re);
    for (const [name, re] of suppressions)
      state.suppressions[kind][name] += countMatches(text, re);
    if (kind === 'test') {
      for (const [name, re] of Object.entries(testRes))
        state.tests[name] += countMatches(text, re);
    } else if (lines > config.largeFileLines) {
      large.push({ path: blob.path, lines });
    }
  });

  state.largeFiles.count = large.length;
  state.largeFiles.lines = large.reduce((sum, f) => sum + f.lines, 0);
  state.largeFiles.top = topBy(large, 'lines');
  const sumValues = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  state.typeEscapes.totalSource = sumValues(state.typeEscapes.source);
  state.typeEscapes.totalTest = sumValues(state.typeEscapes.test);
  state.suppressions.total =
    sumValues(state.suppressions.source) + sumValues(state.suppressions.test);

  if (config.sql) {
    const sqlContents = contents.slice(code.length);
    state.sql = sqlState(
      sql.map((blob, i) => ({
        path: blob.path,
        text: sqlContents[i].toString('utf8'),
        schema: is.isSchema(blob.path),
      })),
      config.sql.largeFunctionLines ?? 300,
    );
  }
  return state;
}

const NAME = String.raw`((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)`;
const FUNCTION_HEAD = new RegExp(
  String.raw`create\s+(?:or\s+replace\s+)?function\s+${NAME}\s*\(`,
  'gi',
);
const NEXT_FUNCTION = /create\s+(?:or\s+replace\s+)?function\s/i;
const FUNCTION_DROP = new RegExp(
  String.raw`drop\s+function\s+(?:if\s+exists\s+)?${NAME}`,
  'gi',
);

const normaliseName = (raw) =>
  raw
    .replaceAll('"', '')
    .toLowerCase()
    .replace(/^public\./, '');

// Postgres spellings that name the same type, so `varchar` and `character varying` match.
const TYPE_ALIASES = {
  varchar: 'character varying',
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  int2: 'smallint',
  bool: 'boolean',
  timestamptz: 'timestamp with time zone',
  'timestamp without time zone': 'timestamp',
  timetz: 'time with time zone',
  'time without time zone': 'time',
  float8: 'double precision',
  float4: 'real',
  decimal: 'numeric',
};
const MULTI_WORD_TYPE = new Set([
  'double',
  'timestamp',
  'time',
  'character',
  'bit',
  'interval',
  'national',
]);
const MODES = new Set(['in', 'out', 'inout', 'variadic']);

/** Text between the parenthesis at `open` and its match, or null if it never closes. */
function parenthesised(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/**
 * Identity signature of an argument list, as Postgres keys overloads: input types only,
 * without names, defaults, OUT arguments or type modifiers. `(p_id uuid, p_days int = 7)`
 * and `(uuid, integer)` both give "uuid,integer".
 */
export function signature(args) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of args) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  const types = [];
  for (const part of parts) {
    const arg = part
      .replace(/\s+default\s[\s\S]*$|\s*=[\s\S]*$/i, '')
      .replace(/\([^)]*\)/g, '')
      .trim()
      .toLowerCase();
    if (!arg) continue;
    const tokens = arg.split(/\s+/);
    if (MODES.has(tokens[0])) {
      if (tokens.shift() === 'out') continue;
    }
    if (tokens.length > 1 && !MULTI_WORD_TYPE.has(tokens[0])) tokens.shift();
    const type = tokens
      .join(' ')
      .replaceAll('"', '')
      .replace(/^public\./, '');
    types.push(TYPE_ALIASES[type] ?? type);
  }
  return types.join(',');
}

/**
 * Function definitions and drops in SQL text, in text order: [{ name, signature, lines }]
 * for a definition, [{ name, signature, dropped: true }] for a drop. A drop without an
 * argument list has a null signature and removes every overload. Bodies must be
 * dollar-quoted; a body quoted any other way reads as 0 lines.
 */
export function sqlFunctions(text) {
  const found = [];
  FUNCTION_HEAD.lastIndex = 0;
  let match;
  while ((match = FUNCTION_HEAD.exec(text))) {
    const name = normaliseName(match[1]);
    const args = parenthesised(text, match.index + match[0].length - 1) ?? '';
    const sig = signature(args);
    // The body's opening quote must follow AS within this statement: a BEGIN ATOMIC or
    // single-quoted body must not borrow the next function's dollar quote.
    const headEnd = match.index + match[0].length;
    const next = text.slice(headEnd).search(NEXT_FUNCTION);
    const rest = text.slice(
      match.index,
      next < 0 ? text.length : headEnd + next,
    );
    const open = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(rest);
    if (!open) {
      found.push({ name, signature: sig, lines: 0, at: match.index });
      continue;
    }
    const bodyStart = match.index + open.index + open[0].length;
    const bodyEnd = text.indexOf(open[1], bodyStart);
    if (bodyEnd < 0) break;
    found.push({
      name,
      signature: sig,
      lines: text.slice(bodyStart, bodyEnd).split('\n').length,
      at: match.index,
    });
    FUNCTION_HEAD.lastIndex = bodyEnd + open[1].length;
  }
  FUNCTION_DROP.lastIndex = 0;
  while ((match = FUNCTION_DROP.exec(text))) {
    const after = match.index + match[0].length;
    const open = /^\s*\(/.exec(text.slice(after, after + 200));
    const args = open ? parenthesised(text, after + open[0].length - 1) : null;
    found.push({
      name: normaliseName(match[1]),
      signature: args === null ? null : signature(args),
      dropped: true,
      at: match.index,
    });
  }
  return found
    .sort((a, b) => a.at - b.at)
    .map(({ at: _at, ...event }) => event);
}

/**
 * Migration count and function size. Each function overload is measured at its latest
 * definition, replaying migrations in file order and honouring drops, so the measure covers
 * history from before a repo kept declarative schemas. Repos with schemas but no migrations
 * replay those.
 */
export function sqlState(files, largeFunctionLines) {
  const migrations = files
    .filter((f) => !f.schema)
    .sort((a, b) => a.path.localeCompare(b.path));
  const replayed =
    migrations.length > 0 ? migrations : files.filter((f) => f.schema);
  const live = new Map();
  const definitions = new Map();
  for (const file of replayed) {
    for (const event of sqlFunctions(file.text)) {
      if (event.dropped) {
        if (event.signature !== null)
          live.delete(`${event.name}(${event.signature})`);
        else
          for (const key of live.keys())
            if (key.startsWith(`${event.name}(`)) live.delete(key);
        continue;
      }
      live.set(`${event.name}(${event.signature})`, {
        name: event.name,
        lines: event.lines,
        path: file.path,
      });
      definitions.set(event.name, (definitions.get(event.name) ?? 0) + 1);
    }
  }
  const liveNames = new Set([...live.values()].map((fn) => fn.name));
  const functions = [...live.values()];
  const large = functions.filter((fn) => fn.lines > largeFunctionLines);
  return {
    migrations: migrations.length,
    functions: functions.length,
    largeFunctions: {
      threshold: largeFunctionLines,
      count: large.length,
      lines: large.reduce((sum, fn) => sum + fn.lines, 0),
    },
    largestFunctions: topBy(functions, 'lines'),
    mostRedefined: topBy(
      [...definitions]
        .filter(([name]) => liveNames.has(name))
        .map(([name, count]) => ({ name, count })),
      'count',
    ),
  };
}

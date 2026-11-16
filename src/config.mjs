/**
 * ABOUTME: Loads gardener.config.json from the repository root and merges it over generic
 * defaults. The config is the only repo-specific part of the harness: which paths are code,
 * tests, generated or churn noise, and the size limits that count as large.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, matchesGlob } from 'node:path';

import { git } from './git.mjs';

const CODE = '**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}';

// A package runner and its flags (`pnpm --filter web run`); a bare `test` needs one, or the
// shell's own `test -f x` would count as a check.
const RUNNER = String.raw`(?:npx|bunx|pnpm|npm|yarn|bun|uv|poetry|deno)\s+(?:-{1,2}[\w-]+(?:[= ][^\s-]\S*)?\s+)*(?:(?:run|exec|dlx|x)\s+)?(?:-{1,2}[\w-]+(?:[= ][^\s-]\S*)?\s+)*`;
const CHECK_TOOLS = String.raw`vitest|jest|mocha|playwright|cypress|tsc\b|typecheck|type-check|lint|eslint|oxlint|biome|pytest|mypy|pyright|ruff|cargo\s+(?:test|check|clippy|nextest)|go\s+(?:test|vet)|node\s+--test|make\s+(?:test|check|lint)|just\s+(?:test|check|lint)|tlc\b|apalache|lake\s+build`;
const VERIFY_COMMANDS = String.raw`^(?:\w+=\S*\s+)*(?:${RUNNER}(?:test\b|test:|check\b|${CHECK_TOOLS})|(?:${CHECK_TOOLS}))`;

// Bump when a code change alters what a cached snapshot or rework result contains.
const SNAPSHOT_VERSION = 7;
const REWORK_VERSION = 2;

export const DEFAULTS = {
  // null: the remote's default branch (origin/HEAD), else HEAD.
  branch: null,
  code: [CODE],
  tests: [
    `**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}`,
    '**/__tests__/**',
    '**/test/**',
    '**/tests/**',
  ],
  // Never measured: vendored, built or generated output.
  ignore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/*.d.ts',
    '**/*.min.js',
    '**/generated/**',
    '**/_generated/**',
    '**/__generated__/**',
    '**/*.generated.*',
    '**/*.gen.*',
    '**/.lake/**',
  ],
  // Measured for size, but left out of churn, hotspots and rework: files every change touches.
  churnIgnore: [
    '**/*.lock',
    '**/pnpm-lock.yaml',
    '**/package-lock.json',
    '**/*.json',
    '**/*.md',
    '**/*.mdx',
  ],
  largeFileLines: 800,
  reworkDays: 14,
  reworkSample: 150,
  // Below these, a window's shares read as unmeasured rather than as a percentage of noise.
  minCommits: 5,
  minReworkLines: 100,
  // compare: touched files this share of all commits also change are too shared to attribute.
  sharedFileShare: 0.05,
  // Your own weeds: name -> regex, or { pattern, in, except } to count it only in some paths.
  // Weeds are looked for in code files only; without `in`, in source files (not tests).
  weeds: {},
  // Plain-text rules for agents, measured in lines: the layer that should stay thin.
  agentInstructions: [
    '**/AGENTS.md',
    '**/CLAUDE.md',
    '**/GEMINI.md',
    '**/.cursorrules',
    '**/.cursor/rules/**',
    '**/.windsurfrules',
    '**/.github/copilot-instructions.md',
    '**/.github/instructions/**',
    '**/.claude/skills/**/*.md',
    '**/.claude/agents/**/*.md',
    '**/.claude/commands/**/*.md',
    '**/.agents/**/*.md',
  ],
  // Lint and dependency-rule configs, where rules turned on are counted.
  lintConfigs: [
    '**/eslint.config.{js,mjs,cjs,ts,mts,cts}',
    '**/.eslintrc',
    '**/.eslintrc.{json,js,cjs,yml,yaml}',
    '**/.oxlintrc.json',
    '**/biome.json',
    '**/biome.jsonc',
    '**/.dependency-cruiser.{js,cjs,mjs,json}',
    // Vite+ keeps lint settings in the root Vite config.
    'vite.config.{ts,mts,js,mjs}',
  ],
  // Source files of lint rules written for this codebase; their tests aren't counted.
  lintRuleFiles: [
    '**/eslint-rules/**/*.{js,mjs,cjs,ts,mts,cts}',
    '**/lint-rules/**/*.{js,mjs,cjs,ts,mts,cts}',
    '**/eslint-plugin-*/**/rules/**/*.{js,mjs,cjs,ts,mts,cts}',
    '**/oxlint-plugin-*/**/rules/**/*.{js,mjs,cjs,ts,mts,cts}',
    '**/*.grit',
  ],
  // Formal models and proofs: TLA+, Lean, Alloy, Quint, Dafny.
  formalSpecs: ['**/*.tla', '**/*.lean', '**/*.als', '**/*.qnt', '**/*.dfy'],
  patterns: {
    typeEscapes: {
      'as any': String.raw`\bas\s+any\b`,
      ': any': String.raw`:\s*any\b(?![-.\w])`,
      'any type argument': String.raw`[<,|]\s*any\s*(?=[>,|\[])`,
      'as unknown as': String.raw`\bas\s+unknown\s+as\b`,
      '@ts-ignore': '@ts-ignore',
      '@ts-expect-error': '@ts-expect-error',
      '@ts-nocheck': '@ts-nocheck',
    },
    suppressions: {
      'eslint-disable': 'eslint-disable',
      'oxlint-disable': 'oxlint-disable',
      'biome-ignore': 'biome-ignore',
    },
    testCases: String.raw`^\s*(?:it|test)(?:\.(?:each|only|skip|concurrent|todo|fails)\b[^(]*)?\(`,
    mockModules: String.raw`\b(?:vi|jest)\.mock\(`,
    callAssertions: String.raw`\.toHaveBeenCalled\w*\(`,
    assertions: String.raw`\bexpect\(`,
    // Where a comment starts on a line: a whole-line comment, or a trailing `// …`.
    comment: String.raw`^\s*(?:\/\/|\/\*|\*)|\s\/\/\s`,
    // Comments that excuse or defer (matched case-insensitively, in comment text only).
    workaroundComments: String.raw`\b(?:workaround|work around|hack(?:y|ish)?|for now|temporar(?:y|ily)|quick fix|band-?aid|intentional(?:ly)?|deliberately|on purpose|TODO|FIXME|XXX)\b`,
    // A rule turned on in a lint config: `"no-console": "error"`, `'x/y': ['warn', …]`.
    enabledRule: String.raw`["']?[@\w/.-]+["']?\s*:\s*\[?\s*["']?(?:error|warn|deny|[12])["']?(?![\w-])`,
    // Test files that generate inputs (property-based) or drive the running app (end to end).
    propertyTests: String.raw`from\s+["']fast-check["']|require\(["']fast-check["']\)|\bfc\.(?:assert|property|asyncProperty)\(|@given\(|\bproptest!|\bquickcheck\b|@antithesishq\/bombadil`,
    e2eTests: String.raw`from\s+["']@playwright\/test["']|\bcy\.visit\(|\bbrowser\.url\(|from\s+["']@wdio\/`,
  },
  sql: null,
  // match null: the repository's directory name, which both agents record in their paths.
  transcripts: {
    claudeProjectsDir: '~/.claude/projects',
    codexSessionsDir: '~/.codex/sessions',
    match: null,
    // A shell command that checks the work: tests, type checks, lint, model checkers.
    verifyCommands: VERIFY_COMMANDS,
    // An agent tool that looks at the running app: a browser, DevTools, a screenshot.
    verifyTools: String.raw`playwright|chrome|devtools|browser|screenshot|preview_(?:snapshot|evaluate|act)`,
  },
};

const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/**
 * Reads `<root>/gardener.config.json` (or `path`) and returns the resolved config, filling
 * the branch and transcript match from the repository when the file leaves them unset.
 */
export function loadConfig(root, path) {
  const file = path ?? join(root, 'gardener.config.json');
  const user = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const config = resolveConfig(user);
  config.branch ??= defaultBranch(root);
  config.transcripts.match ??= repoName(root);
  return config;
}

/** The remote's default branch as a ref (origin/main, origin/master), else HEAD. */
export function defaultBranch(root) {
  try {
    return git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
  } catch {
    return 'HEAD';
  }
}

// Worktrees live in their own directories; the shared git dir names the repository.
const repoName = (root) => {
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  return basename(common.endsWith('.git') ? dirname(common) : common);
};

/** Merges a user config over the defaults: glob lists extend, `patterns` merges one level deep. */
export function resolveConfig(user) {
  const merged = { ...DEFAULTS, ...user };
  merged.patterns = { ...DEFAULTS.patterns, ...user.patterns };
  for (const key of [
    'tests',
    'ignore',
    'churnIgnore',
    'agentInstructions',
    'lintConfigs',
    'lintRuleFiles',
    'formalSpecs',
  ])
    merged[key] = [...DEFAULTS[key], ...(user[key] ?? [])];
  merged.weeds = Object.fromEntries(
    Object.entries(user.weeds ?? {}).map(([name, weed]) => {
      const resolved = typeof weed === 'string' ? { pattern: weed } : weed;
      if (typeof resolved?.pattern !== 'string' || resolved.pattern === '')
        throw new Error(`weed "${name}" needs a pattern`);
      return [name, resolved];
    }),
  );
  merged.transcripts = { ...DEFAULTS.transcripts, ...user.transcripts };
  // Each cache keys on only the settings that change its results, so tuning a window or a
  // sample size keeps every cached commit.
  merged.cacheKeys = {
    snapshot: digest([
      SNAPSHOT_VERSION,
      merged.code,
      merged.tests,
      merged.ignore,
      merged.patterns,
      merged.sql,
      merged.largeFileLines,
      merged.weeds,
      merged.agentInstructions,
      merged.lintConfigs,
      merged.lintRuleFiles,
      merged.formalSpecs,
    ]),
    rework: digest([
      REWORK_VERSION,
      merged.code,
      merged.ignore,
      merged.churnIgnore,
      merged.sql?.schemas,
      merged.reworkDays,
    ]),
  };
  return merged;
}

/** A path test that passes when any of `globs` matches. */
export const anyGlob = (globs) => (path) =>
  globs.some((glob) => matchesGlob(path, glob));

/** Path classifiers derived from a resolved config. */
export function classifiers(config) {
  const ignored = anyGlob(config.ignore);
  const churnIgnored = anyGlob(config.churnIgnore);
  const code = anyGlob(config.code);
  const test = anyGlob(config.tests);
  // The glob test first: most paths fail it, so the longer ignore list rarely runs.
  const kept = (globs) => {
    const matches = anyGlob(globs);
    return (path) => matches(path) && !ignored(path);
  };
  const isLintRuleFile = kept(config.lintRuleFiles);
  // Schemas carry SQL change; migrations are write-once copies of it and would double-count.
  const schemaFiles = config.sql
    ? anyGlob(config.sql.schemas ?? [])
    : () => false;
  return {
    ignored,
    isCode: (path) => !ignored(path) && code(path),
    isTest: (path) => test(path),
    isAgentInstructions: kept(config.agentInstructions),
    isLintConfig: kept(config.lintConfigs),
    isLintRule: (path) => isLintRuleFile(path) && !test(path),
    isFormalSpec: kept(config.formalSpecs),
    /** Files whose churn says something about health: not ignored, generated or fan-out noise. */
    isChurn: (path) =>
      !ignored(path) &&
      !churnIgnored(path) &&
      (code(path) || schemaFiles(path)),
    isSchema: schemaFiles,
    isMigration: config.sql
      ? anyGlob(config.sql.migrations ?? [])
      : () => false,
  };
}

/** A file whose opening lines say a tool wrote it. */
export function looksGenerated(head) {
  return (
    /@generated\b/i.test(head) ||
    /auto-?generated/i.test(head) ||
    (/\bgenerated\b/i.test(head) && /do not edit/i.test(head))
  );
}

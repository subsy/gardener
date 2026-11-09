/**
 * ABOUTME: Thin git plumbing for the garden harness. Every read goes through the object
 * store (ls-tree, cat-file, log, blame) so any historical commit can be measured without a
 * checkout.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const MAX_BUFFER = 1 << 30;
const GIT_ARGS = ['-c', 'core.quotepath=false'];
const execFileAsync = promisify(execFile);

export const DAY = 86400;

/** Lines in a file's contents; a trailing newline doesn't start another line. */
export function lineCount(buf) {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) n += 1;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

/** Runs git asynchronously and resolves to stdout text; lets callers fan out blame and diff. */
export async function gitAsync(cwd, args) {
  const { stdout } = await execFileAsync('git', [...GIT_ARGS, ...args], {
    cwd,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/** Runs git and returns stdout as UTF-8 text. */
export function git(cwd, args, input) {
  return execFileSync('git', [...GIT_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Resolves a revision to a full commit SHA. */
export function revParse(cwd, rev) {
  return git(cwd, ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
}

/**
 * When `ref` last moved, in Unix seconds, from its reflog (a fetch or commit that updated
 * it); null for a ref with no reflog.
 */
export function refUpdatedAt(cwd, ref) {
  try {
    const out = git(cwd, [
      'reflog',
      'show',
      '-1',
      '--date=unix',
      '--format=%gd',
      ref,
    ]);
    const at = /@\{(\d+)\}/.exec(out)?.[1];
    return at ? Number(at) : null;
  } catch {
    return null;
  }
}

/** Committer time of a commit, in Unix seconds. */
export function commitTime(cwd, rev) {
  return Number(git(cwd, ['show', '-s', '--format=%ct', rev]).trim());
}

/** Last first-parent commit on `branch` at or before `epochSeconds`, or null. */
export function commitAtOrBefore(cwd, branch, epochSeconds) {
  const sha = git(cwd, [
    'rev-list',
    '-1',
    '--first-parent',
    `--before=@${epochSeconds}`,
    branch,
  ]).trim();
  return sha || null;
}

/** Blobs tracked at `rev`: [{ oid, path }]. Submodules and symlinks are skipped. */
export function listBlobs(cwd, rev) {
  const out = git(cwd, [
    'ls-tree',
    '-r',
    '-z',
    '--format=%(objectmode) %(objecttype) %(objectname)\t%(path)',
    rev,
  ]);
  const blobs = [];
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    if (type !== 'blob' || mode === '120000') continue;
    blobs.push({ oid, path: entry.slice(tab + 1) });
  }
  return blobs;
}

/** Reads blob contents in one `cat-file --batch` call; returns Buffers in input order. */
export function readBlobs(cwd, oids) {
  if (oids.length === 0) return [];
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd,
    input: `${oids.join('\n')}\n`,
    maxBuffer: MAX_BUFFER * 2,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const contents = [];
  let offset = 0;
  while (offset < out.length) {
    const headerEnd = out.indexOf(0x0a, offset);
    const header = out.toString('utf8', offset, headerEnd).split(' ');
    const size = Number(header[2]);
    const start = headerEnd + 1;
    contents.push(out.subarray(start, start + size));
    offset = start + size + 1;
  }
  return contents;
}

/**
 * First-parent commits on `branch` with committer time in [since, until), oldest first.
 * Each carries its numstat: [{ path, added, deleted }] (binary files count as 0).
 */
export function logWindow(cwd, branch, since, until) {
  const out = git(cwd, [
    'log',
    '--first-parent',
    '--no-renames',
    '--numstat',
    `--since=@${since - DAY}`,
    `--until=@${until + DAY}`,
    '--format=%x1e%H%x1f%P%x1f%ct%x1f%s',
    branch,
  ]);
  const commits = [];
  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const [head, ...rest] = record.split('\n');
    const [sha, parents, ct, subject] = head.split('\x1f');
    const time = Number(ct);
    if (time < since || time >= until) continue;
    const files = [];
    for (const line of rest) {
      if (!line) continue;
      const [added, deleted, path] = line.split('\t');
      files.push({
        path,
        added: Number(added) || 0,
        deleted: Number(deleted) || 0,
      });
    }
    commits.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      time,
      subject,
      files,
    });
  }
  return commits.reverse();
}

/**
 * Line ranges in `parent` that `sha` removed or rewrote, for files present on both sides.
 * Returns Map(path -> [[start, count]]).
 */
export async function rewrittenRanges(cwd, parent, sha, paths) {
  const ranges = new Map();
  if (paths.length === 0) return ranges;
  const out = await gitAsync(cwd, [
    'diff',
    // Pin the output format: user config (noprefix, mnemonic prefixes, colour, external
    // diff tools) would otherwise change the headers this parser reads.
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--no-color',
    '--no-ext-diff',
    '-U0',
    '--no-renames',
    '--diff-filter=M',
    parent,
    sha,
    '--',
    ...paths,
  ]);
  let current = null;
  let inHeader = false;
  for (const line of out.split('\n')) {
    // Only the file header names the path: inside a hunk, a removed SQL comment also starts with "---".
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      current = null;
      continue;
    }
    if (inHeader && line.startsWith('--- a/')) {
      current = line.slice(6).replace(/\t$/, '');
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (!hunk) continue;
    inHeader = false;
    if (!current) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    if (!ranges.has(current)) ranges.set(current, []);
    ranges.get(current).push([start, count]);
  }
  return ranges;
}

/**
 * Blames `ranges` of `path` at `rev`, walking history only back to `sinceEpoch`.
 * Returns { lines, recent }: lines blamed, and how many came from a commit after the limit.
 */
export async function blameRecent(cwd, rev, path, ranges, sinceEpoch) {
  const args = ['blame', '--porcelain', `--since=@${sinceEpoch}`];
  for (const [start, count] of ranges) args.push('-L', `${start},+${count}`);
  args.push(rev, '--', path);
  return parseBlamePorcelain(await gitAsync(cwd, args));
}

/** Counts porcelain blame lines, splitting those owned by boundary commits (older than the limit). */
export function parseBlamePorcelain(out) {
  const lineOwners = [];
  const boundary = new Set();
  let currentSha = null;
  for (const line of out.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line);
    if (header) {
      currentSha = header[1];
      lineOwners.push(currentSha);
    } else if (line === 'boundary' && currentSha) {
      boundary.add(currentSha);
    }
  }
  const recent = lineOwners.filter((sha) => !boundary.has(sha)).length;
  return { lines: lineOwners.length, recent };
}

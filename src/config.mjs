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

// Bump when a code change alters what a cached snapshot or rework result contains.
const SNAPSHOT_VERSION = 6;
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
  },
  sql: null,
  // match null: the repository's directory name, which both agents record in their paths.
  transcripts: {
    claudeProjectsDir: '~/.claude/projects',
    codexSessionsDir: '~/.codex/sessions',
    match: null,
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
  merged.tests = [...DEFAULTS.tests, ...(user.tests ?? [])];
  merged.ignore = [...DEFAULTS.ignore, ...(user.ignore ?? [])];
  merged.churnIgnore = [...DEFAULTS.churnIgnore, ...(user.churnIgnore ?? [])];
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

const anyGlob = (globs) => (path) =>
  globs.some((glob) => matchesGlob(path, glob));

/** Path classifiers derived from a resolved config. */
export function classifiers(config) {
  const ignored = anyGlob(config.ignore);
  const churnIgnored = anyGlob(config.churnIgnore);
  const code = anyGlob(config.code);
  const test = anyGlob(config.tests);
  // Schemas carry SQL change; migrations are write-once copies of it and would double-count.
  const schemaFiles = config.sql
    ? anyGlob(config.sql.schemas ?? [])
    : () => false;
  return {
    ignored,
    isCode: (path) => !ignored(path) && code(path),
    isTest: (path) => test(path),
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

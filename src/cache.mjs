/**
 * ABOUTME: On-disk cache for per-commit results (snapshots, rework). A commit's numbers never
 * change under the same settings, so entries are keyed by the config's cache key and the SHA
 * and kept in the git common dir, shared by every worktree of the repository.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { git } from './git.mjs';

const readEntries = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Missing or torn: start empty; every entry can be recomputed.
    return {};
  }
};

/**
 * Opens the `kind` cache ('snapshot' or 'rework') for `config`. `save()` merges new entries
 * into whatever another run wrote meanwhile, then replaces the file atomically.
 */
export function openCache(cwd, kind, config, { disabled = false } = {}) {
  if (disabled) return { get: () => undefined, set: () => {}, save: () => {} };
  const common = git(cwd, ['rev-parse', '--git-common-dir']).trim();
  const dir = join(
    isAbsolute(common) ? common : join(cwd, common),
    'gardener-cache',
  );
  const file = join(dir, `${kind}-${config.cacheKeys[kind]}.json`);
  const entries = readEntries(file);
  const added = {};
  return {
    get: (key) => entries[key],
    set: (key, value) => {
      entries[key] = value;
      added[key] = value;
    },
    save: () => {
      if (Object.keys(added).length === 0) return;
      mkdirSync(dir, { recursive: true });
      const merged = { ...readEntries(file), ...added };
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged));
      renameSync(tmp, file);
      for (const key of Object.keys(added)) delete added[key];
    },
  };
}

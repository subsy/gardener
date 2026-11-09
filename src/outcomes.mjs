/**
 * ABOUTME: Outcome metrics over a time window of first-parent history: commit mix, net
 * lines, rework (lines rewritten within N days of being written), hotspots, and the
 * before/after comparison for one intervention commit.
 */
import { availableParallelism } from 'node:os';

import { classifiers } from './config.mjs';
import {
  blameRecent,
  commitTime,
  DAY,
  refUpdatedAt,
  lineCount,
  listBlobs,
  logWindow,
  readBlobs,
  rewrittenRanges,
} from './git.mjs';

const TYPES = new Set([
  'feat',
  'fix',
  'refactor',
  'perf',
  'test',
  'docs',
  'chore',
  'ci',
  'build',
  'style',
  'revert',
]);

// Leading verbs of plain-English titles, for history from before a repo adopted conventional commits.
const VERBS = [
  [/^(fix|fixes|fixed|repair|resolve|correct|stop|prevent|handle)\b/i, 'fix'],
  [
    /^(refactor|simplify|remove|delete|drop|retire|consolidate|clean ?up|extract|rename)\b/i,
    'refactor',
  ],
  [
    /^(add|build|implement|introduce|create|support|enable|launch|ship|show|let)\b/i,
    'feat',
  ],
];

/**
 * Conventional-commit type of a subject line. A title without a conventional prefix is
 * typed by its leading verb ("Fix …" is a fix), ignoring a bracketed tag such as [codex];
 * anything else is 'other'.
 */
export function commitType(subject) {
  const match = /^(\w+)(?:\([^)]*\))?!?:/.exec(subject);
  const type = match?.[1].toLowerCase();
  if (type && TYPES.has(type)) return type;
  if (match) return 'other';
  const plain = subject.replace(/^(\[[^\]]*\]\s*)+/, '');
  return VERBS.find(([re]) => re.test(plain))?.[1] ?? 'other';
}

/** Every k-th item so that at most `limit` remain, spread evenly across the list. */
export function evenSample(items, limit) {
  if (items.length <= limit) return items;
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, i) => items[Math.floor(i * step)]);
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

const CONCURRENCY = Math.max(2, availableParallelism());

/** Lines one commit rewrote in existing files, and how many were under `reworkDays` old. */
async function commitRework(cwd, commit, config, is, pathFilter) {
  const parent = commit.parents[0];
  if (!parent) return { lines: 0, recent: 0 };
  const paths = commit.files
    .filter((f) => f.deleted > 0 && is.isChurn(f.path) && pathFilter(f.path))
    .map((f) => f.path);
  const ranges = await rewrittenRanges(cwd, parent, commit.sha, paths);
  let lines = 0;
  let recent = 0;
  for (const [path, fileRanges] of ranges) {
    const blamed = await blameRecent(
      cwd,
      parent,
      path,
      fileRanges,
      commit.time - config.reworkDays * DAY,
    );
    lines += blamed.lines;
    recent += blamed.recent;
  }
  return { lines, recent };
}

/**
 * Share of rewritten lines that were written in the `reworkDays` before each commit.
 * Only modifications count: deleting a whole file is never rework. Per-commit results are
 * cached only for the unfiltered measure; share is null when nothing was rewritten.
 */
export async function rework(cwd, commits, config, { pathFilter, cache } = {}) {
  const is = classifiers(config);
  const store = pathFilter ? undefined : cache;
  const perCommit = await mapLimit(commits, CONCURRENCY, async (commit) => {
    const hit = store?.get(commit.sha);
    if (hit) return hit;
    const result = await commitRework(
      cwd,
      commit,
      config,
      is,
      pathFilter ?? (() => true),
    );
    store?.set(commit.sha, result);
    return result;
  });
  const lines = perCommit.reduce((sum, r) => sum + r.lines, 0);
  const recent = perCommit.reduce((sum, r) => sum + r.recent, 0);
  return { lines, recent, share: lines > 0 ? recent / lines : null };
}

/** Commit mix, net lines and rework for first-parent commits in [since, until). */
export async function windowOutcomes(cwd, config, since, until, cache) {
  const is = classifiers(config);
  const commits = logWindow(cwd, config.branch, since, until);
  const byType = {};
  let added = 0;
  let deleted = 0;
  let netDeleting = 0;
  // Commits that removed more than they added without a refactor prefix: deletion work by another name.
  let otherDeleting = 0;
  for (const commit of commits) {
    const type = commitType(commit.subject);
    byType[type] = (byType[type] ?? 0) + 1;
    let a = 0;
    let d = 0;
    for (const f of commit.files) {
      if (!is.isChurn(f.path)) continue;
      a += f.added;
      d += f.deleted;
    }
    added += a;
    deleted += d;
    if (d > a) {
      netDeleting += 1;
      if (type !== 'refactor') otherDeleting += 1;
    }
  }
  const sampleSize = config.reworkSample;
  const fixes = commits.filter((c) => commitType(c.subject) === 'fix');
  const total = commits.length;
  const [allRework, fixRework] = await Promise.all([
    rework(cwd, evenSample(commits, sampleSize), config, { cache }),
    rework(cwd, evenSample(fixes, sampleSize), config, { cache }),
  ]);
  // A share of a handful of commits or lines is noise: one fix in a quiet week reads 100%.
  const enough = total >= config.minCommits;
  const shareOf = (n) => (enough ? n / total : null);
  const floor = (r) => ({ ...r, share: r.lines >= config.minReworkLines ? r.share : null });
  return {
    since,
    until,
    commits: total,
    byType,
    fixShare: shareOf(byType.fix ?? 0),
    cleanupShare: shareOf((byType.refactor ?? 0) + otherDeleting),
    lines: { added, deleted, net: added - deleted },
    netDeletingShare: shareOf(netDeleting),
    rework: floor(allRework),
    fixRework: floor(fixRework),
    reworkSampled: {
      all: Math.min(total, sampleSize),
      fix: Math.min(fixes.length, sampleSize),
    },
  };
}

/**
 * Files ranked by fix commits × √(current lines): the places that keep needing repair and
 * are big enough that the repair is expensive. Lines are read at the window's last commit.
 */
export function hotspots(cwd, config, since, until, limit = 20) {
  const is = classifiers(config);
  const commits = logWindow(cwd, config.branch, since, until);
  const stats = new Map();
  for (const commit of commits) {
    const fix = commitType(commit.subject) === 'fix';
    for (const f of commit.files) {
      if (!is.isChurn(f.path)) continue;
      const s = stats.get(f.path) ?? { path: f.path, commits: 0, fixes: 0 };
      s.commits += 1;
      if (fix) s.fixes += 1;
      stats.set(f.path, s);
    }
  }
  const last = commits.at(-1);
  if (!last) return [];
  const candidates = [...stats.values()].filter((s) => s.fixes >= 2);
  const blobs = new Map(listBlobs(cwd, last.sha).map((b) => [b.path, b.oid]));
  const present = candidates.filter((s) => blobs.has(s.path));
  const contents = readBlobs(
    cwd,
    present.map((s) => blobs.get(s.path)),
  );
  return present
    .map((s, i) => {
      const lines = lineCount(contents[i]);
      return {
        ...s,
        lines,
        fixShare: s.fixes / s.commits,
        score: Math.round(s.fixes * Math.sqrt(lines)),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Direction of a count between two equal-length windows. */
export function countSignal(before, after) {
  if (before + after < 4) return 'unmeasured';
  if (after <= before * 0.7 && before - after >= 2) return 'better';
  if (after >= before * 1.3 && after - before >= 2) return 'worse';
  return 'flat';
}

/** Direction of a rework share; needs enough rewritten lines on both sides to say anything. */
export function shareSignal(before, after, minLines = 200) {
  if (!before || !after || before.lines < minLines || after.lines < minLines)
    return 'unmeasured';
  const delta = after.share - before.share;
  if (delta <= -0.05) return 'better';
  if (delta >= 0.05) return 'worse';
  return 'flat';
}

/**
 * Combines signals into a result: improved, mixed, declined, no clear change, still
 * measuring or unmeasured.
 * The windows show what moved on the touched files, not what caused it.
 */
export function verdict(signals, complete) {
  if (!complete) return 'still measuring';
  const measured = signals.filter((s) => s !== 'unmeasured');
  if (measured.length === 0) return 'unmeasured';
  const better = measured.includes('better');
  const worse = measured.includes('worse');
  if (better && worse) return 'mixed';
  if (better) return 'improved';
  if (worse) return 'declined';
  return 'no clear change';
}

/**
 * Before/after for one intervention commit on main: fix commits and rework on the files it
 * touched, `days` before vs `days` after it merged. Touched files that at least
 * `sharedFileShare` of all commits in the before window also changed are set aside: their
 * fixes mostly belong to unrelated work, so they would drown the intervention's own signal.
 */
export async function compareWindows(
  cwd,
  config,
  commit,
  touched,
  days,
  now = Math.floor(Date.now() / 1000),
) {
  const beforeAll = logWindow(
    cwd,
    config.branch,
    commit.time - days * DAY,
    commit.time,
  );
  const changes = new Map();
  for (const c of beforeAll)
    for (const f of c.files)
      changes.set(f.path, (changes.get(f.path) ?? 0) + 1);
  const shared = [...touched].filter(
    (path) =>
      beforeAll.length > 0 &&
      (changes.get(path) ?? 0) / beforeAll.length >= config.sharedFileShare,
  );
  const sharedSet = new Set(shared);
  const kept = new Set([...touched].filter((path) => !sharedSet.has(path)));
  const onKept = (path) => kept.has(path);
  const side = async (commits, since, until) => {
    const relevant = commits.filter((c) =>
      c.files.some((f) => kept.has(f.path)),
    );
    return {
      since,
      until,
      commits: relevant.length,
      fixes: relevant.filter((c) => commitType(c.subject) === 'fix').length,
      rework: await rework(
        cwd,
        evenSample(relevant, config.reworkSample),
        config,
        { pathFilter: onKept },
      ),
    };
  };
  const before = await side(beforeAll, commit.time - days * DAY, commit.time);
  const afterUntil = commit.time + 1 + days * DAY;
  const after = await side(
    logWindow(cwd, config.branch, commit.time + 1, afterUntil),
    commit.time + 1,
    afterUntil,
  );
  // A ref last updated before the after window closed can't show that window's commits;
  // missing commits would read as zero fixes, so the result is unmeasured until it's
  // fetched. An old tip alone isn't proof: a quiet branch has no later commit to show.
  const tipBefore = commitTime(cwd, config.branch) < after.until;
  const updatedAt = refUpdatedAt(cwd, config.branch);
  const branchBehind =
    now >= after.until &&
    tipBefore &&
    (updatedAt === null || updatedAt < after.until);
  const complete = now >= after.until && !branchBehind;
  const signals = {
    fixes: countSignal(before.fixes, after.fixes),
    rework: shareSignal(before.rework, after.rework),
  };
  return {
    days,
    sharedFileShare: config.sharedFileShare,
    measured: kept.size,
    shared,
    before,
    after,
    complete,
    branchBehind,
    signals,
    result: branchBehind
      ? 'unmeasured'
      : verdict(Object.values(signals), complete),
  };
}

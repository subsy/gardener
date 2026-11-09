/**
 * ABOUTME: Weekly history of the garden: for each complete ISO week (Monday 00:00 UTC
 * boundaries), the code state at the week's last commit on the branch plus that week's
 * outcomes. Snapshots and per-commit rework are cached, so re-runs only measure new weeks.
 */
import { openCache } from './cache.mjs';
import { commitAtOrBefore, DAY } from './git.mjs';
import { windowOutcomes } from './outcomes.mjs';
import {
  collectPushes,
  fetchMergedPrs,
  originRepo,
  prOutcomes,
  summarisePushes,
} from './sources.mjs';
import { cachedSnapshot } from './state.mjs';

const WEEK = 7 * DAY;

/** Start of the ISO week containing `epoch`, in Unix seconds (Monday 00:00 UTC). */
export function weekStart(epoch) {
  const day = Math.floor(epoch / DAY);
  // 1970-01-01 was a Thursday; Monday-based weekday index:
  const weekday = (day + 3) % 7;
  return (day - weekday) * DAY;
}

/** ISO week label such as 2026-W45 for the week starting at `start`. */
export function weekLabel(start) {
  const thursday = new Date((start + 3 * DAY) * 1000);
  const year = thursday.getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4) / 1000;
  const week = 1 + Math.round((start - weekStart(jan4)) / WEEK);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Measures the last `weeks` complete weeks, oldest first. `github` and `transcripts` add
 * review load and push time; weeks those sources don't cover report null.
 */
export async function history(
  cwd,
  config,
  {
    weeks,
    github = false,
    transcripts = false,
    noCache = false,
    now = Date.now() / 1000,
    onWeek,
  } = {},
) {
  const snapshots = openCache(cwd, 'snapshot', config, { disabled: noCache });
  const reworkCache = openCache(cwd, 'rework', config, { disabled: noCache });
  const repo = github ? originRepo(cwd) : null;
  const lastStart = weekStart(now) - WEEK;
  const pushes = transcripts
    ? await collectPushes(
        config.transcripts,
        lastStart - (weeks - 1) * WEEK,
        lastStart + WEEK,
      )
    : null;
  const rows = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const since = lastStart - i * WEEK;
    const until = since + WEEK;
    const commit = commitAtOrBefore(cwd, config.branch, until - 1);
    if (!commit) continue;
    const row = {
      week: weekLabel(since),
      since,
      until,
      state: cachedSnapshot(snapshots, cwd, commit, config),
      outcomes: await windowOutcomes(cwd, config, since, until, reworkCache),
      prs: repo ? prOutcomes(fetchMergedPrs(repo, since, until)) : null,
      pushes: transcripts ? summarisePushes(pushes, since, until) : null,
    };
    // Saved every week, so an interrupted multi-minute run resumes where it stopped.
    snapshots.save();
    reworkCache.save();
    rows.push(row);
    onWeek?.(row);
  }
  return rows;
}

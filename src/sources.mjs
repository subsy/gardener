/**
 * ABOUTME: Optional outcome sources outside git: merged-PR review load from GitHub (via the
 * gh CLI) and push durations from Claude Code transcripts. Each returns null when its source
 * is missing, so a gap reads as unmeasured rather than zero.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { git } from './git.mjs';

const PR_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number createdAt mergedAt
      commits(last: 40) { totalCount nodes { commit { committedDate } } }
      reviews(first: 1) { totalCount nodes { submittedAt } }
      reviewThreads { totalCount }
    } }
  }
}`;

/** Value at quantile `q` of a numeric list, or null for an empty list. */
export function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const isoSeconds = (epoch) =>
  new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const gh = (args, cwd) =>
  JSON.parse(
    execFileSync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }),
  );

/** Merge commit and title of PR `number`; throws when it isn't merged. */
export function fetchPr(cwd, number) {
  const pr = gh(
    ['pr', 'view', String(number), '--json', 'mergeCommit,title,number'],
    cwd,
  );
  if (!pr.mergeCommit) throw new Error(`PR #${number} is not merged`);
  return { sha: pr.mergeCommit.oid, title: `#${pr.number} ${pr.title}` };
}

/**
 * Fetches PRs merged in [since, until) for `repo` ("owner/name"); null when gh isn't
 * installed. GitHub search returns at most 1,000 results, so keep windows to a few weeks.
 */
export function fetchMergedPrs(repo, since, until) {
  try {
    return searchMergedPrs(repo, since, until);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// GitHub search stops at 1,000 results, so a busier window is split in half until each
// part fits; a repository merging hundreds of PRs a day needs this every week.
const SEARCH_CAP = 1000;

function searchMergedPrs(repo, since, until) {
  const q = `repo:${repo} is:pr is:merged merged:${isoSeconds(since)}..${isoSeconds(until - 1)}`;
  const prs = [];
  let after = null;
  do {
    const args = ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `q=${q}`];
    if (after) args.push('-f', `after=${after}`);
    const page = gh(args).data.search;
    if (!after && page.issueCount > SEARCH_CAP && until - since > 60) {
      const mid = since + Math.floor((until - since) / 2);
      return [...searchMergedPrs(repo, since, mid), ...searchMergedPrs(repo, mid, until)];
    }
    prs.push(...page.nodes.filter((n) => n.number));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return prs;
}

/**
 * Review load per merged PR: commits, commits pushed after the first review (fix rounds),
 * and review threads opened. Only a PR's last 40 commits are fetched (to keep GitHub API cost low); when every one of
 * them follows the first review the true count is unknown, so that PR is left out of the
 * after-review figures rather than undercounted.
 */
export function prOutcomes(prs) {
  if (!prs) return null;
  const commits = prs.map((p) => p.commits.totalCount);
  const afterReview = prs.flatMap((p) => {
    const first = p.reviews.nodes[0]?.submittedAt;
    if (!first) return [0];
    const nodes = p.commits.nodes;
    const after = nodes.filter((n) => n.commit.committedDate > first).length;
    const truncated = nodes.length < p.commits.totalCount;
    return truncated && after === nodes.length ? [] : [after];
  });
  const threads = prs.map((p) => p.reviewThreads.totalCount);
  return {
    prs: prs.length,
    commitsPerPr: {
      median: quantile(commits, 0.5),
      p90: quantile(commits, 0.9),
    },
    commitsAfterReview: {
      median: quantile(afterReview, 0.5),
      p90: quantile(afterReview, 0.9),
    },
    reviewThreads: {
      median: quantile(threads, 0.5),
      p90: quantile(threads, 0.9),
    },
  };
}

/** `owner/name` of the origin remote, or null. */
export function originRepo(cwd) {
  try {
    const url = git(cwd, ['remote', 'get-url', 'origin']).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

// `git push` or `git -C <dir> push` at the start of a command; quoted mentions can still match.
const PUSH = /(^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?push\b/;
// A push handed to a detached process (systemd-run without --wait or --pty, nohup, setsid, a
// trailing `&`) returns at once, so the command's time says nothing about the push's.
const DETACHED =
  /\bsystemd-run\b(?![^;|]*\s(?:--wait|--pty|--pipe|-P|-t)\b)|\bnohup\b|\bsetsid\b|(^|[^&])&\s*$/;
const isForegroundPush = (command) => PUSH.test(command) && !DETACHED.test(command);

const expandHome = (path) => path.replace(/^~(?=\/)/, homedir());

/** `.jsonl` files under `root` (recursively) modified at or after `since`; [] if absent. */
function transcriptFiles(root, since, keepDir = () => true) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const dir of readdirSync(root)) {
    if (!keepDir(dir)) continue;
    const full = join(root, dir);
    let names;
    try {
      names = statSync(full).isDirectory() ? readdirSync(full, { recursive: true }).map(String) : [];
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(full, name);
      try {
        if (statSync(path).mtimeMs / 1000 >= since) files.push(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return files;
}

/**
 * Foreground pushes run by coding agents that started in [since, until): when each started,
 * how long it took and whether it failed, from Claude Code transcripts (project dirs whose
 * name contains `match`) and Codex sessions (commands whose working directory contains
 * `match`). Resumed and forked sessions repeat history, so pushes dedupe by call id. Null
 * when neither agent left any transcript in the window.
 */
export async function collectPushes(transcripts, since, until) {
  if (!transcripts.match) return null;
  const sources = [
    ...transcriptFiles(expandHome(transcripts.claudeProjectsDir), since, (dir) => dir.includes(transcripts.match)).map(
      (path) => () => pushesIn(path, since, until),
    ),
    ...transcriptFiles(expandHome(transcripts.codexSessionsDir), since).map(
      (path) => () => codexPushesIn(path, transcripts.match, since, until),
    ),
  ];
  if (sources.length === 0) return null;
  const byId = new Map();
  for (const read of sources) {
    try {
      for (const push of await read()) byId.set(push.id, push);
    } catch (error) {
      // Live sessions move and clean up transcripts while we read them.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return [...byId.values()];
}

/** Push count, median and p90 seconds, and failure share for pushes started in [since, until). */
export function summarisePushes(pushes, since, until) {
  const inWindow = (pushes ?? []).filter((p) => p.at >= since && p.at < until);
  if (inWindow.length === 0) return null;
  const durations = inWindow.map((p) => p.seconds);
  return {
    pushes: inWindow.length,
    byAgent: Object.fromEntries(['claude', 'codex'].map((agent) => [agent, inWindow.filter((p) => p.agent === agent).length])),
    medianSeconds: quantile(durations, 0.5),
    p90Seconds: quantile(durations, 0.9),
    failureShare: inWindow.filter((p) => p.failed).length / inWindow.length,
  };
}

/** Push summary for one window; see collectPushes. */
export async function pushOutcomes(transcripts, since, until) {
  return summarisePushes(
    await collectPushes(transcripts, since, until),
    since,
    until,
  );
}

/** Foreground pushes in one Claude Code transcript: [{ id, agent, at, seconds, failed }]. */
export async function pushesIn(path, since, until) {
  const pending = new Map();
  const pushes = [];
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const mayStart = line.includes('"tool_use"') && line.includes('push');
    const mayEnd = pending.size > 0 && line.includes('"tool_result"');
    if (!mayStart && !mayEnd) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry.timestamp) / 1000;
    for (const part of Array.isArray(entry.message?.content)
      ? entry.message.content
      : []) {
      if (
        part.type === 'tool_use' &&
        part.name === 'Bash' &&
        !part.input?.run_in_background &&
        isForegroundPush(part.input?.command ?? '')
      ) {
        if (at >= since && at < until) pending.set(part.id, at);
      } else if (part.type === 'tool_result' && pending.has(part.tool_use_id)) {
        // A long command the harness moved to the background returns early; its time is not the push's.
        if (!entry.toolUseResult?.backgroundTaskId) {
          const start = pending.get(part.tool_use_id);
          pushes.push({
            id: part.tool_use_id,
            agent: 'claude',
            at: start,
            seconds: at - start,
            failed: part.is_error === true,
          });
        }
        pending.delete(part.tool_use_id);
      }
    }
  }
  return pushes;
}

/**
 * Pushes in one Codex session: completed command executions run under a working directory
 * containing `match`. Codex records each command's exit code and run time, so the start is
 * the completion time less the duration.
 */
export async function codexPushesIn(path, match, since, until) {
  const pushes = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('CommandExecution') || !line.includes('push')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const item = entry.payload?.item;
    if (item?.type !== 'CommandExecution' || !item.duration) continue;
    const command = Array.isArray(item.command) ? item.command.at(-1) : String(item.command ?? '');
    if (!isForegroundPush(command) || !decodeURIComponent(String(item.cwd ?? '')).includes(match)) continue;
    const seconds = item.duration.secs + item.duration.nanos / 1e9;
    const at = Date.parse(entry.timestamp) / 1000 - seconds;
    if (at < since || at >= until) continue;
    pushes.push({ id: item.id, agent: 'codex', at, seconds, failed: item.exit_code !== 0 });
  }
  return pushes;
}

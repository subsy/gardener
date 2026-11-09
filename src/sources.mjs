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
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number createdAt mergedAt
      commits(last: 100) { totalCount nodes { commit { committedDate } } }
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
  const q = `repo:${repo} is:pr is:merged merged:${isoSeconds(since)}..${isoSeconds(until - 1)}`;
  const prs = [];
  let after = null;
  try {
    do {
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${PR_QUERY}`,
        '-f',
        `q=${q}`,
      ];
      if (after) args.push('-f', `after=${after}`);
      const page = gh(args).data.search;
      prs.push(...page.nodes.filter((n) => n.number));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return prs;
}

/**
 * Review load per merged PR: commits, commits pushed after the first review (fix rounds),
 * and review threads opened. Only a PR's last 100 commits are fetched; when every one of
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

/**
 * Foreground pushes run by Claude Code agents that started in [since, until): when each
 * started, how long it took (tool call to result) and whether it failed. Reads transcripts
 * under project dirs whose name contains `match`; resumed and forked sessions repeat
 * history, so pushes dedupe by tool id. Null when there are no transcripts.
 */
export async function collectPushes(transcripts, since, until) {
  const root = transcripts.claudeProjectsDir.replace(/^~(?=\/)/, homedir());
  if (!transcripts.match || !existsSync(root)) return null;
  const byId = new Map();
  let files = 0;
  for (const dir of readdirSync(root)) {
    if (!dir.includes(transcripts.match)) continue;
    const full = join(root, dir);
    for (const name of readdirSync(full, { recursive: true })) {
      if (!String(name).endsWith('.jsonl')) continue;
      const path = join(full, name);
      try {
        if (statSync(path).mtimeMs / 1000 < since) continue;
        files += 1;
        for (const push of await pushesIn(path, since, until))
          byId.set(push.id, push);
      } catch (error) {
        // Live sessions move and clean up transcripts while we read them.
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return files > 0 ? [...byId.values()] : null;
}

/** Push count, median and p90 seconds, and failure share for pushes started in [since, until). */
export function summarisePushes(pushes, since, until) {
  const inWindow = (pushes ?? []).filter((p) => p.at >= since && p.at < until);
  if (inWindow.length === 0) return null;
  const durations = inWindow.map((p) => p.seconds);
  return {
    pushes: inWindow.length,
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

/** Foreground pushes in one Claude Code transcript: [{ id, at, seconds, failed }]. */
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
        PUSH.test(part.input?.command ?? '')
      ) {
        if (at >= since && at < until) pending.set(part.id, at);
      } else if (part.type === 'tool_result' && pending.has(part.tool_use_id)) {
        // A long command the harness moved to the background returns early; its time is not the push's.
        if (!entry.toolUseResult?.backgroundTaskId) {
          const start = pending.get(part.tool_use_id);
          pushes.push({
            id: part.tool_use_id,
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

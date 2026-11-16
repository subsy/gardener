/**
 * ABOUTME: Optional outcome sources outside git: merged-PR review load from GitHub (via the
 * gh CLI), and from Claude Code and Codex transcripts, push durations and how much command
 * time went to checking the work. Each returns null when its source is missing, so a gap
 * reads as unmeasured rather than zero.
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
      author { login }
      commits(last: 40) { totalCount nodes { commit { committedDate } } }
      reviews(first: 50) { totalCount nodes { submittedAt author { __typename login } } }
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

// Review bots: GitHub Apps report as Bot; some older integrations are users named `…[bot]`.
const isBot = (author) =>
  author?.__typename === 'Bot' || /\[bot\]$/.test(author?.login ?? '');

/**
 * Whether anyone other than the PR's author and bots left a review; null when no fetched
 * review is a person's but more reviews exist than were fetched, so the answer is unknown.
 */
export function humanReviewed(pr) {
  const human = pr.reviews.nodes.some(
    (r) => r.author && !isBot(r.author) && r.author.login !== pr.author?.login,
  );
  if (human) return true;
  return pr.reviews.totalCount > pr.reviews.nodes.length ? null : false;
}

/** Share of `items` that pass `test`; null for an empty list. */
const share = (items, test) =>
  items.length ? items.filter(test).length / items.length : null;

/**
 * Review load per merged PR: commits, commits pushed after the first review (fix rounds),
 * review threads opened, and the share merged without a human review. Only a PR's last 40 commits are fetched (to keep GitHub API cost low); when every one of
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
    unreviewedShare: share(prs.map(humanReviewed).filter((r) => r !== null), (r) => !r),
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

/**
 * Classifies agent commands and tools: `verifies(command)` for a shell command that runs a
 * check in any step of a `&&` chain (a detached one returns at once, so its check didn't
 * run), `verifyingTool(name)` for a tool that looks at the running app.
 */
export function verifyClassifier(transcripts) {
  const command = new RegExp(transcripts.verifyCommands);
  const tool = new RegExp(transcripts.verifyTools, 'i');
  return {
    verifies: (text) =>
      !DETACHED.test(text) &&
      text
        .split(/&&|\|\||;|\n/)
        .map((step) => step.trim().replace(/^(?:cd\s+\S+|timeout\s+\S+)\s*/, '').trim())
        .some((step) => command.test(step)),
    verifyingTool: (name) => tool.test(name),
  };
}

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
 * Timed commands and tool calls that coding agents started in [since, until): shell
 * commands and MCP tools, each { id, agent, at, seconds, failed, push, verify }. Claude Code
 * transcripts are read from project dirs whose name contains `match`, Codex sessions when the
 * command (or, for MCP tools, the session) ran in a directory containing `match`. Resumed
 * and forked sessions repeat history, so calls dedupe by id. Null when neither agent left
 * any transcript in the window.
 */
export async function collectAgentCalls(transcripts, since, until) {
  if (!transcripts.match) return null;
  const is = verifyClassifier(transcripts);
  const sources = [
    ...transcriptFiles(expandHome(transcripts.claudeProjectsDir), since, (dir) => dir.includes(transcripts.match)).map(
      (path) => () => claudeCallsIn(path, is, since, until),
    ),
    ...transcriptFiles(expandHome(transcripts.codexSessionsDir), since).map(
      (path) => () => codexCallsIn(path, transcripts.match, is, since, until),
    ),
  ];
  if (sources.length === 0) return null;
  const byId = new Map();
  for (const read of sources) {
    try {
      for (const call of await read()) byId.set(call.id, call);
    } catch (error) {
      // Live sessions move and clean up transcripts while we read them.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return [...byId.values()];
}

const inWindow = (calls, since, until) =>
  (calls ?? []).filter((c) => c.at >= since && c.at < until);

/** Push count, median and p90 seconds, and failure share for pushes started in [since, until). */
export function summarisePushes(calls, since, until) {
  const pushes = inWindow(calls, since, until).filter((c) => c.push);
  if (pushes.length === 0) return null;
  const durations = pushes.map((p) => p.seconds);
  return {
    pushes: pushes.length,
    byAgent: Object.fromEntries(['claude', 'codex'].map((agent) => [agent, pushes.filter((p) => p.agent === agent).length])),
    medianSeconds: quantile(durations, 0.5),
    p90Seconds: quantile(durations, 0.9),
    failureShare: pushes.filter((p) => p.failed).length / pushes.length,
  };
}

/**
 * How much of the agents' command and tool work in [since, until) checked the work: the
 * share of calls, and of the time spent in them, that ran tests, type checks, lint or a look
 * at the running app.
 */
export function summariseVerification(calls, since, until) {
  const all = inWindow(calls, since, until);
  if (all.length === 0) return null;
  const checks = all.filter((c) => c.verify);
  const seconds = all.reduce((sum, c) => sum + c.seconds, 0);
  const checkSeconds = checks.reduce((sum, c) => sum + c.seconds, 0);
  return {
    calls: all.length,
    checks: checks.length,
    callShare: checks.length / all.length,
    timeShare: seconds > 0 ? checkSeconds / seconds : null,
  };
}

/** Agent push time and verification share for one window; see collectAgentCalls. */
export async function agentOutcomes(transcripts, since, until) {
  const calls = await collectAgentCalls(transcripts, since, until);
  return {
    pushes: summarisePushes(calls, since, until),
    verification: summariseVerification(calls, since, until),
  };
}

// Claude Code tools that run something: the shell, and any MCP server's tools.
const isTimedTool = (name) => name === 'Bash' || name?.startsWith('mcp__');

const RESULT_ID = '"tool_use_id":"';

/** Whether `line` carries the result of any call in `pending`, found without parsing it. */
function resultsPending(line, pending) {
  for (let at = line.indexOf(RESULT_ID); at >= 0; at = line.indexOf(RESULT_ID, at + 1)) {
    const start = at + RESULT_ID.length;
    if (pending.has(line.slice(start, line.indexOf('"', start)))) return true;
  }
  return false;
}

/** Timed calls in one Claude Code transcript; see collectAgentCalls. */
export async function claudeCallsIn(path, is, since, until) {
  const pending = new Map();
  const calls = [];
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    // Most lines are reads, edits and their results, often large: skip them unparsed.
    const mayStart =
      line.includes('"tool_use"') &&
      (line.includes('"name":"Bash"') || line.includes('"name":"mcp__'));
    const mayEnd =
      pending.size > 0 &&
      line.includes('"tool_result"') &&
      resultsPending(line, pending);
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
      if (part.type === 'tool_use' && isTimedTool(part.name)) {
        // Written so an entry without a timestamp (NaN) is left out, not let in.
        if (!(at >= since && at < until) || part.input?.run_in_background) continue;
        const command = part.name === 'Bash' ? (part.input?.command ?? '') : null;
        pending.set(part.id, {
          at,
          push: command !== null && isForegroundPush(command),
          verify: command === null ? is.verifyingTool(part.name) : is.verifies(command),
        });
      } else if (part.type === 'tool_result' && pending.has(part.tool_use_id)) {
        // A long command the harness moved to the background returns early; its time is not the command's.
        if (!entry.toolUseResult?.backgroundTaskId) {
          const start = pending.get(part.tool_use_id);
          calls.push({
            id: part.tool_use_id,
            agent: 'claude',
            at: start.at,
            seconds: at - start.at,
            failed: part.is_error === true,
            push: start.push,
            verify: start.verify,
          });
        }
        pending.delete(part.tool_use_id);
      }
    }
  }
  return calls;
}

/**
 * Timed calls in one Codex session: completed command executions run under a working
 * directory containing `match`, and MCP tool calls in a session that started in one. Codex
 * records each call's run time, so the start is the completion time less the duration.
 */
export async function codexCallsIn(path, match, is, since, until) {
  const calls = [];
  const tools = [];
  let sessionMatches = false;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const meta = line.includes('"session_meta"');
    const call =
      line.includes('item_completed') &&
      (line.includes('CommandExecution') || (sessionMatches && line.includes('McpToolCall')));
    if (!meta && !call) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'session_meta') {
      sessionMatches ||= decodeURIComponent(String(entry.payload?.cwd ?? '')).includes(match);
      continue;
    }
    if (entry.payload?.type !== 'item_completed') continue;
    const item = entry.payload.item;
    if (!item?.duration) continue;
    const seconds = item.duration.secs + item.duration.nanos / 1e9;
    const at = Date.parse(entry.timestamp) / 1000 - seconds;
    if (!(at >= since && at < until)) continue;
    if (item.type === 'CommandExecution') {
      const command = Array.isArray(item.command) ? item.command.at(-1) : String(item.command ?? '');
      if (!decodeURIComponent(String(item.cwd ?? '')).includes(match)) continue;
      calls.push({
        id: item.id,
        agent: 'codex',
        at,
        seconds,
        failed: item.exit_code !== 0,
        push: isForegroundPush(command),
        verify: is.verifies(command),
      });
    } else if (item.type === 'McpToolCall') {
      tools.push({
        id: item.id,
        agent: 'codex',
        at,
        seconds,
        failed: item.status !== 'completed',
        push: false,
        verify: is.verifyingTool(`${item.server}__${item.tool}`),
      });
    }
  }
  return [...calls, ...tools];
}

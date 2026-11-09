#!/usr/bin/env node
/**
 * ABOUTME: `garden` command line. Measures the health of the repository it runs in:
 * snapshot (code state of a commit), window (outcomes over recent days), hotspots,
 * compare (before/after for one PR or commit) and history (weekly trend, optional HTML).
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { openCache } from './cache.mjs';
import { classifiers, loadConfig } from './config.mjs';
import { commitTime, DAY, git, revParse } from './git.mjs';
import { history } from './history.mjs';
import { compareWindows, hotspots, windowOutcomes } from './outcomes.mjs';
import {
  formatCompare,
  formatHistory,
  formatHotspots,
  formatSnapshot,
  formatWindow,
  historyHtml,
} from './report.mjs';
import {
  fetchMergedPrs,
  fetchPr,
  originRepo,
  prOutcomes,
  pushOutcomes,
} from './sources.mjs';
import { cachedSnapshot, snapshot } from './state.mjs';

const USAGE = `Usage: garden <command> [options]

Commands
  snapshot [rev]        Code state of a commit (default: the configured branch)
  window                Outcomes over the last --days (default 7)
  hotspots              Files ranked by fix commits x size over the last --days (default 60)
  compare <pr|rev>      Before/after for a merged PR number or a commit on the branch
  history               Weekly trend over the last --weeks complete weeks (default 26)

Options
  --days <n>            Window length; for compare, days either side (default 28)
  --weeks <n>           Weeks of history
  --limit <n>           Hotspot rows (default 20)
  --github              Add merged-PR review load (needs the gh CLI)
  --transcripts         Add agent push time from Claude Code transcripts
  --html <file>         history: write the trend charts as a self-contained page
  --markdown            compare: print Markdown for a PR comment
  --json                Print raw JSON
  --branch <ref>        Override the configured branch
  --config <file>       Config file (default: garden.config.json at the repo root)
  --no-cache            Recompute everything
`;

/** Parses a numeric option, failing loudly instead of producing NaN windows. */
function count(name, value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`--${name} must be a positive whole number, got ${value}`);
  return n;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      days: { type: 'string' },
      weeks: { type: 'string' },
      limit: { type: 'string' },
      github: { type: 'boolean', default: false },
      transcripts: { type: 'boolean', default: false },
      html: { type: 'string' },
      markdown: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      branch: { type: 'string' },
      config: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  const cwd = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const config = loadConfig(cwd, values.config);
  if (values.branch) config.branch = values.branch;
  const now = Math.floor(Date.now() / 1000);
  const print = (json, text) =>
    process.stdout.write(
      `${values.json ? JSON.stringify(json, null, 2) : text()}\n`,
    );

  if (command === 'snapshot') {
    const state = snapshot(cwd, target ?? config.branch, config);
    print(state, () => formatSnapshot(state));
  } else if (command === 'window') {
    const since = now - count('days', values.days, 7) * DAY;
    const cache = openCache(cwd, 'rework', config, {
      disabled: values['no-cache'],
    });
    const outcomes = await windowOutcomes(cwd, config, since, now, cache);
    cache.save();
    const repo = values.github ? originRepo(cwd) : null;
    const prs = repo ? prOutcomes(fetchMergedPrs(repo, since, now)) : null;
    const pushes = values.transcripts
      ? await pushOutcomes(config.transcripts, since, now)
      : null;
    print({ outcomes, prs, pushes }, () => formatWindow(outcomes, prs, pushes));
  } else if (command === 'hotspots') {
    const spots = hotspots(
      cwd,
      config,
      now - count('days', values.days, 60) * DAY,
      now,
      count('limit', values.limit, 20),
    );
    print(spots, () => formatHotspots(spots));
  } else if (command === 'compare') {
    if (!target) throw new Error('compare needs a PR number or a commit');
    const result = await compare(
      cwd,
      config,
      target,
      count('days', values.days, 28),
      now,
    );
    print(result, () => formatCompare(result, values.markdown));
  } else if (command === 'history') {
    const rows = await history(cwd, config, {
      weeks: count('weeks', values.weeks, 26),
      github: values.github,
      transcripts: values.transcripts,
      noCache: values['no-cache'],
      now,
      onWeek: (row) => process.stderr.write(`measured ${row.week}\n`),
    });
    if (values.html) writeFileSync(values.html, historyHtml(rows));
    print(rows, () => formatHistory(rows));
  } else {
    throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

/** Resolves a PR number (via gh) or a revision, then measures its before/after. */
async function compare(cwd, config, target, days, now) {
  const pr = /^#?\d+$/.test(target)
    ? fetchPr(cwd, target.replace('#', ''))
    : null;
  const sha = revParse(cwd, pr?.sha ?? target);
  const parent = revParse(cwd, `${sha}^1`);
  const is = classifiers(config);
  const touched = new Set(
    git(cwd, ['diff', '--name-only', '--no-renames', parent, sha])
      .split('\n')
      .filter((p) => p && is.isChurn(p)),
  );
  const snapshots = openCache(cwd, 'snapshot', config);
  const before = cachedSnapshot(snapshots, cwd, parent, config);
  const after = cachedSnapshot(snapshots, cwd, sha, config);
  snapshots.save();
  const windows = await compareWindows(
    cwd,
    config,
    { sha, time: commitTime(cwd, sha) },
    touched,
    days,
    now,
  );
  return {
    title: pr?.title ?? null,
    sha,
    touched: touched.size,
    before,
    after,
    windows,
  };
}

main().catch((error) => {
  process.stderr.write(`garden: ${error.message}\n`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * ABOUTME: Writes the README's example chart page from made-up history: a team that starts
 * using gardener in week 8 of 26. The numbers are illustrative, not from a real repository.
 * Usage: node scripts/demo-history.mjs <out.html> [dark|light]
 */
import { writeFileSync } from 'node:fs';

import { weekLabel, weekStart } from '../src/history.mjs';
import { historyHtml } from '../src/report.mjs';

const WEEKS = 26;
const ADOPTED = 8;
const WEEK = 7 * 86400;
const FIRST = weekStart(Date.UTC(2026, 4, 11) / 1000);

// Deterministic noise, so the page is the same on every run.
let seed = 20261110;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const jitter = (value, share) => value * (1 + (random() - 0.5) * 2 * share);

/** Value at week `i` along straight lines between [week, value] points. */
function along(points, i) {
  const next = points.findIndex(([week]) => week >= i);
  if (next <= 0) return points[next === 0 ? 0 : points.length - 1][1];
  const [w0, v0] = points[next - 1];
  const [w1, v1] = points[next];
  return v0 + ((v1 - v0) * (i - w0)) / (w1 - w0);
}

// Each series tells one part of the story. Steps are single cleanup PRs; slopes are habits.
const story = {
  // Growth never stops; the dead-code deletion in week 12 shows as a dip.
  sourceLines: [[0, 482_000], [11, 640_000], [12, 601_000], [25, 792_000]],
  // God files split one PR at a time: a staircase down.
  largeFiles: [[0, 148], [8, 204], [10, 204], [11, 171], [15, 166], [16, 139], [20, 133], [21, 112], [25, 104]],
  // A ratchet in CI: can only go down, so it drifts down.
  escapesSource: [[0, 188], [8, 236], [25, 121]],
  // Tests that only restated the code were deleted in week 13.
  testLines: [[0, 262_000], [12, 522_000], [13, 301_000], [25, 356_000]],
  escapesTest: [[0, 1_120], [12, 1_890], [13, 940], [25, 610]],
  testCases: [[0, 7_600], [12, 15_400], [13, 8_700], [25, 10_900]],
  mocksPer100: [[0, 17], [12, 23.5], [13, 15], [25, 11]],
  suppressions: [[0, 94], [8, 118], [25, 71]],
  sqlLarge: [[0, 55], [9, 71], [14, 71], [15, 52], [19, 50], [20, 38], [25, 34]],
  commits: [[0, 70], [8, 160], [25, 290]],
  fixShare: [[0, 0.46], [8, 0.58], [14, 0.44], [25, 0.27]],
  // The standing cleanup lane starts the week gardener does.
  cleanupShare: [[0, 0.07], [7, 0.05], [8, 0.19], [25, 0.23]],
  rework: [[0, 0.44], [8, 0.52], [25, 0.26]],
  fixRework: [[0, 0.5], [8, 0.63], [25, 0.31]],
  afterReview: [[0, 3], [6, 4], [14, 3], [18, 2], [22, 1], [25, 1]],
  // Pre-push checks kept getting slower, then one PR scoped them to the change.
  pushSeconds: [[4, 150], [8, 215], [13, 340], [14, 72], [25, 58]],
  pushFail: [[4, 0.028], [13, 0.041], [14, 0.019], [25, 0.011]],
};

const at = (key, i, noise = 0) => jitter(along(story[key], i), noise);

const rows = Array.from({ length: WEEKS }, (_, i) => {
  const since = FIRST + i * WEEK;
  const sourceLines = Math.round(at('sourceLines', i, 0.004));
  const largeFiles = Math.round(at('largeFiles', i, 0.008));
  const testCases = Math.round(at('testCases', i, 0.01));
  return {
    week: weekLabel(since),
    since,
    until: since + WEEK,
    state: {
      lines: { source: sourceLines, test: Math.round(at('testLines', i, 0.006)) },
      largeFiles: { count: largeFiles, lines: Math.round(largeFiles * jitter(1_640, 0.02)) },
      typeEscapes: { totalSource: Math.round(at('escapesSource', i, 0.02)), totalTest: Math.round(at('escapesTest', i, 0.015)) },
      suppressions: { total: Math.round(at('suppressions', i, 0.03)) },
      tests: { cases: testCases, mockModules: Math.round((testCases * at('mocksPer100', i, 0.03)) / 100) },
      sql: { largeFunctions: { count: Math.round(at('sqlLarge', i)) } },
    },
    outcomes: {
      commits: Math.round(at('commits', i, 0.22)),
      fixShare: at('fixShare', i, 0.12),
      cleanupShare: at('cleanupShare', i, 0.25),
      rework: { share: at('rework', i, 0.16) },
      fixRework: { share: at('fixRework', i, 0.18) },
    },
    prs: { commitsAfterReview: { median: Math.round(at('afterReview', i)) } },
    // Agent transcripts only go back to week 4.
    pushes: i < 4 ? null : { medianSeconds: at('pushSeconds', i, 0.08), failureShare: at('pushFail', i, 0.15) },
  };
});

const [out, theme = 'dark'] = process.argv.slice(2);
if (!out) throw new Error('usage: node scripts/demo-history.mjs <out.html> [dark|light]');
writeFileSync(out, historyHtml(rows, { title: 'Garden health', note: `Example data. gardener adopted in ${rows[ADOPTED].week}.`, theme }));
console.log(`${out}: ${rows.length} weeks, ${rows[0].week} to ${rows.at(-1).week}`);

/**
 * ABOUTME: Presents garden results: the metric catalogue (what each number is and which
 * direction is healthy), plain-text tables for the terminal, Markdown for PRs, and a
 * self-contained HTML page of weekly trend charts. Missing values render as "Unmeasured".
 */

const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const int = (v) => Math.round(v).toLocaleString('en-US');
const dec = (v) => v.toFixed(2);
const mins = (v) => `${(v / 60).toFixed(1)} min`;
const ratio = (a, b) => (a == null || !b ? null : a / b);

/**
 * The trend metrics. `better` is the healthy direction ('down', 'up' or null for volume);
 * `bars` marks per-week volumes, drawn as bars rather than lines; `tableOnly` keeps a close
 * variant of another metric out of the chart grid and in the table.
 */
export const METRICS = [
  {
    key: 'largeFiles',
    label: 'Source files over the size limit',
    get: (r) => r.state.largeFiles.count,
    fmt: int,
    better: 'down',
  },
  {
    key: 'largeFileLines',
    label: 'Lines in files over the size limit',
    get: (r) => r.state.largeFiles.lines,
    fmt: int,
    better: 'down',
    tableOnly: true,
  },
  {
    key: 'sourceLines',
    label: 'Source lines',
    get: (r) => r.state.lines.source,
    fmt: int,
    better: null,
  },
  {
    key: 'escapesSource',
    label: 'Type escapes in source',
    get: (r) => r.state.typeEscapes.totalSource,
    fmt: int,
    better: 'down',
  },
  {
    key: 'escapesTest',
    label: 'Type escapes in tests',
    get: (r) => r.state.typeEscapes.totalTest,
    fmt: int,
    better: 'down',
  },
  {
    key: 'suppressions',
    label: 'Lint suppressions',
    get: (r) => r.state.suppressions.total,
    fmt: int,
    better: 'down',
  },
  {
    key: 'testWeight',
    label: 'Test lines per source line',
    get: (r) => ratio(r.state.lines.test, r.state.lines.source),
    fmt: dec,
    better: null,
  },
  {
    key: 'mocks',
    label: 'Mocked modules per 100 test cases',
    get: (r) => ratio(r.state.tests.mockModules * 100, r.state.tests.cases),
    fmt: dec,
    better: 'down',
  },
  {
    key: 'sqlLarge',
    label: 'SQL functions over the size limit',
    get: (r) => r.state.sql?.largeFunctions.count ?? null,
    fmt: int,
    better: 'down',
  },
  {
    key: 'commits',
    label: 'Commits per week',
    get: (r) => r.outcomes.commits,
    fmt: int,
    better: null,
    bars: true,
  },
  {
    key: 'fixShare',
    label: 'Fix commits, share of all',
    get: (r) => r.outcomes.fixShare,
    fmt: pct,
    better: 'down',
  },
  {
    key: 'cleanupShare',
    label: 'Cleanup commits, share of all',
    get: (r) => r.outcomes.cleanupShare,
    fmt: pct,
    better: 'up',
  },
  {
    key: 'rework',
    label: 'Rewritten lines under 14 days old',
    get: (r) => r.outcomes.rework.share,
    fmt: pct,
    better: 'down',
  },
  {
    key: 'fixRework',
    label: 'Lines fixes rewrote under 14 days old',
    get: (r) => r.outcomes.fixRework.share,
    fmt: pct,
    better: 'down',
    tableOnly: true,
  },
  {
    key: 'afterReview',
    label: 'Commits after first review, median PR',
    get: (r) => r.prs?.commitsAfterReview.median ?? null,
    fmt: int,
    better: 'down',
  },
  {
    key: 'pushTime',
    label: 'Agent push time, median',
    get: (r) => r.pushes?.medianSeconds ?? null,
    fmt: mins,
    better: 'down',
  },
  {
    key: 'pushFail',
    label: 'Agent pushes failing',
    get: (r) => r.pushes?.failureShare ?? null,
    fmt: pct,
    better: 'down',
  },
];

const show = (metric, value) =>
  value == null ? 'Unmeasured' : metric.fmt(value);

const table = (header, rows) => {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => String(c).padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
  ].join('\n');
};

/** Terminal view of one snapshot. */
export function formatSnapshot(state) {
  const parts = [
    `Commit ${state.commit.slice(0, 10)} (${new Date(state.time * 1000).toISOString().slice(0, 10)})`,
    table(
      ['Measure', 'Value'],
      [
        [
          'Source files / lines',
          `${int(state.files.source)} / ${int(state.lines.source)}`,
        ],
        [
          'Test files / lines',
          `${int(state.files.test)} / ${int(state.lines.test)}`,
        ],
        [
          `Source files over ${state.largeFiles.threshold} lines`,
          `${int(state.largeFiles.count)} (${int(state.largeFiles.lines)} lines)`,
        ],
        [
          'Type escapes, source / tests',
          `${int(state.typeEscapes.totalSource)} / ${int(state.typeEscapes.totalTest)}`,
        ],
        ['Lint suppressions', int(state.suppressions.total)],
        [
          'Test cases / mocked modules / call assertions',
          `${int(state.tests.cases)} / ${int(state.tests.mockModules)} / ${int(state.tests.callAssertions)}`,
        ],
        ...(state.sql
          ? [
              ['Migrations', int(state.sql.migrations)],
              [
                'SQL functions over the size limit',
                `${int(state.sql.largeFunctions.count)} of ${int(state.sql.functions)} (limit ${state.sql.largeFunctions.threshold} lines)`,
              ],
            ]
          : []),
      ],
    ),
    'Largest source files',
    table(
      ['Path', 'Lines'],
      state.largeFiles.top.map((f) => [f.path, int(f.lines)]),
    ),
  ];
  if (state.sql) {
    parts.push(
      'Most-redefined SQL functions',
      table(
        ['Function', 'Definitions'],
        state.sql.mostRedefined.map((f) => [f.name, f.count]),
      ),
    );
  }
  return parts.join('\n\n');
}

// A median/p90 pair; no PRs (or none measurable) reads as a gap, not "null / null".
const spread = (s) =>
  s?.median == null ? 'Unmeasured' : `${s.median} / ${s.p90}`;

/** Terminal view of one outcome window. */
export function formatWindow(o, prs, pushes) {
  const share = (v) => (v == null ? 'Unmeasured' : pct(v));
  return [
    `Window ${day(o.since)} to ${day(o.until)}`,
    table(
      ['Measure', 'Value'],
      [
        ['Commits', int(o.commits)],
        [
          'By type',
          Object.entries(o.byType)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} ${v}`)
            .join(', '),
        ],
        ['Fix share', share(o.fixShare)],
        ['Cleanup share', share(o.cleanupShare)],
        [
          'Lines added / deleted / net',
          `${int(o.lines.added)} / ${int(o.lines.deleted)} / ${int(o.lines.net)}`,
        ],
        [
          `Rewritten lines under 14 days old (${o.reworkSampled.all} commits sampled)`,
          share(o.rework.share),
        ],
        [
          `Same, in fix commits (${o.reworkSampled.fix} sampled)`,
          share(o.fixRework.share),
        ],
        ['Merged PRs', prs ? int(prs.prs) : 'Unmeasured'],
        ['Commits per PR, median / p90', spread(prs?.commitsPerPr)],
        [
          'Commits after first review, median / p90',
          spread(prs?.commitsAfterReview),
        ],
        [
          'Agent pushes / median / p90 / failing',
          pushes
            ? `${pushes.pushes} / ${mins(pushes.medianSeconds)} / ${mins(pushes.p90Seconds)} / ${pct(pushes.failureShare)}`
            : 'Unmeasured',
        ],
      ],
    ),
  ].join('\n\n');
}

/** Terminal view of the hotspot ranking. */
export function formatHotspots(spots) {
  return table(
    ['Path', 'Score', 'Fixes', 'Commits', 'Lines'],
    spots.map((s) => [s.path, int(s.score), s.fixes, s.commits, int(s.lines)]),
  );
}

const STATE_DELTAS = [
  ['Source lines', (s) => s.lines.source],
  ['Test lines', (s) => s.lines.test],
  ['Source files over the size limit', (s) => s.largeFiles.count],
  ['Lines in files over the size limit', (s) => s.largeFiles.lines],
  ['Type escapes, source', (s) => s.typeEscapes.totalSource],
  ['Type escapes, tests', (s) => s.typeEscapes.totalTest],
  ['Lint suppressions', (s) => s.suppressions.total],
  ['Test cases', (s) => s.tests.cases],
  ['Mocked modules', (s) => s.tests.mockModules],
  [
    'SQL functions over the size limit',
    (s) => s.sql?.largeFunctions.count ?? 0,
  ],
];

const signed = (n) => (n > 0 ? `+${int(n)}` : int(n));

/** Terminal or Markdown view of an intervention's before/after. */
export function formatCompare(
  { title, sha, touched, before, after, windows },
  markdown = false,
) {
  const deltaRows = STATE_DELTAS.map(([label, get]) => [
    label,
    int(get(before)),
    int(get(after)),
    signed(get(after) - get(before)),
  ]).filter((r) => r[3] !== '0');
  const side = (w) => [
    int(w.commits),
    int(w.fixes),
    w.rework.share == null
      ? 'Unmeasured'
      : `${pct(w.rework.share)} of ${int(w.rework.lines)}`,
  ];
  const outcomeRows = [
    [
      'Commits touching these files',
      side(windows.before)[0],
      side(windows.after)[0],
    ],
    [
      'Fix commits touching these files',
      side(windows.before)[1],
      side(windows.after)[1],
    ],
    [
      'Rewritten lines under 14 days old',
      side(windows.before)[2],
      side(windows.after)[2],
    ],
  ];
  const md = (header, rows) =>
    [
      `| ${header.join(' | ')} |`,
      `|${header.map(() => '---').join('|')}|`,
      ...rows.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');
  const render = markdown ? md : table;
  return [
    `${title ?? sha.slice(0, 10)}: ${windows.result}`,
    `Files touched: ${touched}; measured: ${windows.measured}. Windows: ${windows.days} days either side of ${day(windows.before.until)}${windows.branchBehind ? ` (${'the branch was last updated before the after window closed: fetch it and rerun'})` : windows.complete ? '' : ' (after window still open)'}.`,
    ...(windows.shared.length
      ? [
          `Set aside as shared (changed by at least ${pct(windows.sharedFileShare)} of commits): ${windows.shared.join(', ')}`,
        ]
      : []),
    'Code state',
    deltaRows.length
      ? render(['Measure', 'Before', 'After', 'Change'], deltaRows)
      : 'No change in the measured code state.',
    'Outcomes on the touched files',
    render(['Measure', 'Before', 'After'], outcomeRows),
  ].join('\n\n');
}

/** Terminal view of the weekly history: one row per week, a column per headline metric. */
export function formatHistory(rows) {
  const cols = METRICS.filter((m) =>
    [
      'largeFiles',
      'escapesSource',
      'fixShare',
      'rework',
      'afterReview',
      'pushTime',
    ].includes(m.key),
  );
  return table(
    ['Week', ...cols.map((m) => m.label)],
    rows.map((r) => [r.week, ...cols.map((m) => show(m, m.get(r)))]),
  );
}

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

/**
 * Self-contained HTML page: one small chart per metric over the weekly rows, with a table of
 * every metric underneath. `theme` is 'auto' (follows the viewer's system), 'dark' or
 * 'light'; `note` is appended to the line under the title.
 */
export function historyHtml(rows, { title = 'Garden health', note = '', theme = 'auto' } = {}) {
  const series = METRICS.map((m) => ({
    label: m.label,
    better: m.better,
    bars: Boolean(m.bars),
    tableOnly: Boolean(m.tableOnly),
    values: rows.map((r) => m.get(r)),
    shown: rows.map((r) => show(m, m.get(r))),
  })).filter((s) => s.values.some((v) => v != null));
  const weeks = rows.map((r) => r.week);
  const charted = series.filter((s) => !s.tableOnly);
  const data = JSON.stringify({ weeks, series: charted }).replace(/</g, '\\u003c');
  const tableRows = rows
    .map(
      (r, i) =>
        `<tr><th scope="row">${escapeHtml(r.week)}</th>${series.map((s) => `<td>${escapeHtml(s.shown[i])}</td>`).join('')}</tr>`,
    )
    .join('');
  const dark =
    'color-scheme:dark;--surface-1:#0e0e0e;--surface-2:#171717;--text-primary:#f0efec;--text-secondary:#b9b8ae;--text-muted:#8b8a82;--grid:#2c2c2a;--series-1:#3987e5;--good:#3fb950;--bad:#f0605d';
  const themeAttr = theme === 'dark' || theme === 'light' ? ` data-theme="${theme}"` : '';
  return `<!doctype html>
<html lang="en"${themeAttr}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f3f2ef;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#76756f;--grid:#e4e3de;--series-1:#2a78d6;--good:#008300;--bad:#c0392b}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{${dark}}}
:root[data-theme="dark"] .viz-root{${dark}}
body{margin:0}
.viz-root{background:var(--surface-1);color:var(--text-primary);font:14px/1.4 system-ui,sans-serif;padding:24px;min-height:100vh;box-sizing:border-box}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--text-secondary);margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.card{background:var(--surface-2);border-radius:10px;padding:16px 18px 12px;position:relative}
.card h2{font-size:13px;font-weight:600;margin:0;color:var(--text-secondary)}
.now{font-size:24px;font-weight:600;margin:6px 0 0;font-variant-numeric:tabular-nums}
.delta{font-size:12px;color:var(--text-muted);margin:2px 0 10px}
.delta .good{color:var(--good)}.delta .bad{color:var(--bad)}
svg{display:block;width:100%;height:110px;overflow:visible}
.axis{display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:4px}
.tip{position:absolute;pointer-events:none;background:var(--surface-1);color:var(--text-primary);border:1px solid var(--grid);border-radius:6px;padding:4px 8px;font-size:12px;white-space:nowrap;display:none;z-index:2}
details{margin-top:24px}
table{border-collapse:collapse;font-size:12px;margin-top:8px}
th,td{padding:3px 8px;border-bottom:1px solid var(--grid);text-align:right}
th[scope=row],thead th:first-child{text-align:left}
</style></head>
<body><div class="viz-root">
<h1>${escapeHtml(title)}</h1>
<p class="sub">Weekly, ${escapeHtml(weeks[0] ?? '')} to ${escapeHtml(weeks.at(-1) ?? '')}. Code state at each week's last commit; outcomes over the week. Gaps are weeks a source doesn't cover.${note ? ` ${escapeHtml(note)}` : ''}</p>
<div class="grid" id="grid"></div>
<details><summary>Table view</summary><table><thead><tr><th>Week</th>${series.map((s) => `<th>${escapeHtml(s.label)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table></details>
</div>
<script>
const {weeks, series} = ${data};
const H = 110, PAD = {l: 4, r: 6, t: 8, b: 4}, ns = 'http://www.w3.org/2000/svg';
const grid = document.getElementById('grid');
const charts = series.map((s) => {
  const card = document.createElement('div'); card.className = 'card';
  const present = s.values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  const [fi, fv] = present[0]; const [li, lv] = present.at(-1);
  let deltaText = 'since ' + weeks[fi];
  if (present.length > 1 && fv !== 0) {
    const change = (lv - fv) / Math.abs(fv);
    const word = (change >= 0 ? '+' : '') + (change * 100).toFixed(0) + '%';
    const cls = s.better && Math.abs(change) >= 0.02 ? ((change < 0) === (s.better === 'down') ? 'good' : 'bad') : '';
    deltaText = '<span class="' + cls + '">' + word + '</span> since ' + weeks[fi] + ' (' + s.shown[fi] + ')';
  }
  card.innerHTML = '<h2></h2><p class="now"></p><p class="delta">' + deltaText + '</p><svg role="img"></svg><div class="axis"><span></span><span></span></div><div class="tip"></div>';
  card.querySelector('h2').textContent = s.label;
  card.querySelector('.now').textContent = s.shown[li];
  const [first, last] = card.querySelectorAll('.axis span');
  first.textContent = weeks[0]; last.textContent = weeks.at(-1);
  const svg = card.querySelector('svg'); svg.setAttribute('aria-label', s.label + ', weekly');
  grid.appendChild(card);
  return {s, card, svg, tip: card.querySelector('.tip'), present, li};
});
// Drawn at the card's real pixel width, so strokes, dots and bars keep their shape at any size.
function draw({s, card, svg, tip, present, li}) {
  const W = svg.getBoundingClientRect().width || 300;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.replaceChildren();
  const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
  const max = Math.max(...present.map(([, v]) => v)); const min = s.bars ? 0 : Math.min(...present.map(([, v]) => v));
  const lo = s.bars ? 0 : min - (max - min) * 0.1; const hi = max + (max - min || Math.abs(max) || 1) * 0.1;
  const x = (i) => PAD.l + (weeks.length === 1 ? 0.5 : i / (weeks.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
  el('line', {x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, stroke: 'var(--grid)', 'stroke-width': 1});
  if (s.bars) {
    const bw = Math.max(2, (W - PAD.l - PAD.r) / weeks.length - 2);
    for (const [i, v] of present) el('rect', {x: x(i) - bw / 2, y: y(v), width: bw, height: Math.max(0, H - y(v)), rx: 2, fill: 'var(--series-1)'});
  } else {
    let d = ''; let prev = -2;
    for (const [i, v] of present) { d += (i === prev + 1 ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '; prev = i; }
    el('path', {d, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'});
    const isolated = (i) => s.values[i - 1] == null && s.values[i + 1] == null;
    for (const [i, v] of present) if (i === li || isolated(i)) el('circle', {cx: x(i), cy: y(v), r: 3.5, fill: 'var(--series-1)', stroke: 'var(--surface-2)', 'stroke-width': 2});
  }
  const cross = el('line', {y1: 0, y2: H, stroke: 'var(--text-muted)', 'stroke-width': 1, visibility: 'hidden'});
  const hit = el('rect', {x: 0, y: 0, width: W, height: H, fill: 'transparent'});
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect(); const px = ev.clientX - box.left;
    let best = 0; for (let i = 0; i < weeks.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    cross.setAttribute('x1', x(best)); cross.setAttribute('x2', x(best)); cross.setAttribute('visibility', 'visible');
    tip.textContent = weeks[best] + ': ' + s.shown[best]; tip.style.display = 'block';
    const cardBox = card.getBoundingClientRect();
    tip.style.left = Math.min(Math.max(0, box.left - cardBox.left + x(best) - 60), cardBox.width - 130) + 'px'; tip.style.top = (box.top - cardBox.top - 30) + 'px';
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
}
const drawAll = () => charts.forEach(draw);
drawAll();
let frame = 0;
addEventListener('resize', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(drawAll); });
</script></body></html>`;
}

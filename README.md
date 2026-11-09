# garden

Measures how healthy a codebase is, from git history alone, and whether the work done to
improve it helped. Every number comes from the object store (`ls-tree`, `cat-file`, `log`,
`blame`), so any past commit can be measured without a checkout, and the same commit
always gives the same numbers.

```bash
pnpm garden snapshot                 # code state of origin/main
pnpm garden window --days 7 --github --transcripts
pnpm garden hotspots --days 60
pnpm garden compare 5255             # before/after for a merged PR
pnpm garden history --weeks 26 --github --transcripts --html /tmp/garden.html
```

Add `--json` to any command for raw output. Results for each commit are cached in the
repository's git directory (`garden-cache/`), shared by every worktree; `--no-cache`
recomputes.

## What it measures

**Code state, per commit** (`snapshot`)

| Measure | Definition |
|---|---|
| Source and test lines | Lines in code files matching `code`, split by `tests`. Ignored and generated files are left out. |
| Files over the size limit | Non-test files longer than `largeFileLines` (800), and the lines they hold. |
| Type escapes | `as any`, `: any`, `any` as a type argument, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, in source and tests separately. A text match, so mentions in comments and strings count too: read it as a trend. |
| Lint suppressions | `eslint-disable`, `oxlint-disable`, `biome-ignore`. |
| Test weight | Test cases (`it(` / `test(`), mocked modules (`vi.mock(` / `jest.mock(`), and call assertions (`toHaveBeenCalled*`). |
| SQL | Migration count, schema functions longer than `sql.largeFunctionLines`, and the functions most often redefined across migrations. |

**Outcomes, per window** (`window`, `history`)

| Measure | Definition |
|---|---|
| Fix share | Share of first-parent commits whose conventional type is `fix`. |
| Cleanup share | `refactor` commits plus any other commit that removed more lines than it added. |
| Rework | Of the lines commits rewrote in existing files, the share written in the previous `reworkDays` (14). Deleting a whole file never counts. Measured with `git blame --since`, on an even sample of up to `reworkSample` commits per window. |
| Rework in fixes | The same, for fix commits only: how much fixing is of code written days ago. |
| Commits after first review | Per merged PR, commits pushed after its first review (needs `gh`). Only a PR's last 100 commits are read; a PR whose 100 all follow its first review is left out. |
| Agent push time | Foreground `git push` calls in Claude Code transcripts: time from call to result, and the share that failed. Pre-push checks run inside it. Pushes the harness moved to the background are left out. |

**Hotspots**: files ranked by fix commits × √(current lines) over the window: the places that
keep needing repair and are big enough that repair is expensive.

**Compare**: for a merged PR or a commit on the branch, the code-state change it made, then
fix commits and rework on the files it touched, `--days` before against `--days` after. The
result is improved, mixed, no clear change, declined, still measuring (the after window is
open) or unmeasured (too little activity to say, or the branch ref was last updated before the after
window does: fetch it and rerun). Touched files that at least
`sharedFileShare` (5%) of all commits also change are set aside and listed: their fixes
mostly belong to other work. It shows what moved on those files, not what caused it.

A source that doesn't cover a week (no transcripts that old, no `gh`) reads `Unmeasured`,
never zero.

## Configuration

`garden.config.json` at the repository root. Glob lists extend the defaults in
`src/config.mjs`; everything else replaces them.

| Key | Meaning |
|---|---|
| `branch` | History to measure (default `origin/main`). |
| `code`, `tests` | Globs for code files and which of them are tests. |
| `ignore` | Never measured: vendored, built or generated output. Files whose header says `@generated` or "generated … do not edit" are skipped automatically. |
| `churnIgnore` | Measured for size but left out of churn, hotspots and rework: files every change touches, such as locale JSON. |
| `largeFileLines`, `reworkDays`, `reworkSample`, `sharedFileShare` | Limits described above. |
| `patterns` | Regexes for escapes, suppressions and test weight. |
| `sql` | `schemas` and `migrations` globs and `largeFunctionLines`; omit for no SQL metrics. |
| `transcripts` | `match`: substring of the Claude Code project directory names for this repository. |

The package imports nothing from the rest of the repository, so it can move to its own
repository unchanged.

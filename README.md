# gardener

When agents write most of your code, the codebase can rot faster than anyone can read it.
`gardener` measures whether it is getting healthier or worse, week by week, from git
history alone, and tells you whether each cleanup you ship actually helped.

```bash
npx @subsy/gardener history --weeks 26 --html garden.html
```

Run it at the root of any git repository. Nothing is uploaded: it reads git objects, plus
the GitHub API and local agent transcripts when you ask it to.

## What you get

On [T3 Code](https://github.com/pingdotgg/t3code), the repository behind Theo's
"[Coding isn't about code anymore](https://www.youtube.com/watch?v=GtJKFhztgdM)":

```console
$ gardener compare 22557 --days 14
#22557 test: delete 11k low-signal tests so CI runs faster and flakes less: improved

Measure                     Before   After    Change
Test lines                  733,398  482,089  -251,309
Test cases                  13,163   6,373    -6,790
Mocked modules              1,185    799      -386

Measure                            Before          After
Fix commits touching these files   1,056           1,046
Rewritten lines under 14 days old  32.8% of 7,121  19.8% of 9,826
```

Half the test suite went, and fixes on the files it touched did not rise. Its weekly history
also shows test cases climbing back from 6,563 to 8,781 within two weeks. A single cleanup
doesn't stay done.

## Commands

| Command | What it answers |
|---|---|
| `snapshot [rev]` | What state is the code in at this commit? |
| `window --days 7` | How did the last week go: fixes, cleanup, rework, review rounds, push time? |
| `hotspots --days 60` | Which files keep needing repair and are big enough to make that expensive? |
| `compare <pr or commit>` | Did this change help the files it touched? |
| `history --weeks 26` | How has all of the above moved, week by week? `--html` writes the charts. |

Add `--github` for review data (needs the `gh` CLI, signed in), `--transcripts` for agent
push times, `--json` for raw output.

## What it measures

**Code state, per commit**

| Measure | Definition |
|---|---|
| Source and test lines | Code files, split into tests and source. Generated, vendored and built files are left out. |
| Files over the size limit | Source files over 800 lines, and the lines they hold. |
| Type escapes | `as any`, `: any`, `any` as a type argument, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`. A text match: read it as a trend. |
| Lint suppressions | `eslint-disable`, `oxlint-disable`, `biome-ignore`. |
| Test weight | Test cases, mocked modules, and assertions that only check a mock was called. |
| SQL (optional) | Migrations, and functions over 300 lines, each measured at its latest definition with drops applied. |

**Outcomes, per window**

| Measure | Definition |
|---|---|
| Fix share | Share of commits that are fixes, from conventional prefixes (`fix:`) or a leading verb ("Fix …"). |
| Cleanup share | Refactors, plus any commit that removed more than it added. |
| Rework | Of the lines commits rewrote, the share written in the 14 days before. Deleting a whole file never counts. |
| Commits after first review | Per merged PR, commits pushed after its first review. |
| Agent push time | How long `git push` takes for Claude Code and Codex agents, pre-push checks included, and how often it fails. |

**Compare** reads fixes and rework on the files a change touched, the same number of days
before and after it merged. The result is improved, mixed, no clear change, declined, still
measuring or unmeasured. It shows what moved, not what caused it: files most commits touch
are set aside, because their fixes mostly belong to other work.

A week a source doesn't cover, or too quiet to say anything about, reads `Unmeasured`,
never zero.

## Configuration

Optional. Put `gardener.config.json` at the repository root. Lists extend the defaults;
everything else replaces them.

```json
{
  "ignore": ["packages/locks/**"],
  "churnIgnore": ["public/locales/**"],
  "sql": {
    "schemas": ["supabase/schemas/*.sql"],
    "migrations": ["supabase/migrations/*.sql"]
  }
}
```

| Key | Meaning |
|---|---|
| `branch` | History to measure. Default: the remote's default branch, else `HEAD`. |
| `code`, `tests`, `ignore` | Globs for code, which of it is tests, and what is never measured. Files headed `@generated` are skipped. |
| `churnIgnore` | Measured for size, left out of churn and rework: files every change touches. |
| `largeFileLines`, `reworkDays`, `reworkSample`, `sharedFileShare`, `minCommits`, `minReworkLines` | Limits described above. |
| `patterns` | Regexes for escapes, suppressions and test weight. |
| `sql` | Migration and schema globs and `largeFunctionLines`. |
| `transcripts` | `match`: the text that identifies this repository in agent transcript paths. Default: its directory name. |

## Requirements

Node 22.5 or later and git 2.36 or later. Results are cached per commit in the
repository's git directory (`gardener-cache/`), shared by its worktrees; `--no-cache`
recomputes.

## Licence

MIT

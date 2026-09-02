# crashfix

`crashfix` is a command-line pipeline that pulls your top Firebase Crashlytics crashes and ANRs, has Claude analyze each one against your actual source, generates a fix on a dedicated branch, validates it by building the affected repos, and — after you approve it in a terminal review UI — opens a pull/merge request per repo. It understands multi-repo Kotlin Multiplatform layouts: one crash can touch the app repo and one or more shared modules, and it produces a single coordinated review and cross-linked PRs.

## Install

```bash
npm i -g crashfix       # then: crashfix <command>
# or, no install:
npx crashfix <command>
```

Requires Node >= 20.

## Prerequisites

- **Firebase CLI auth** — `firebase login` (the Firebase MCP server runs as `npx -y firebase-tools experimental:mcp` and uses your logged-in session, or a service account via `GOOGLE_APPLICATION_CREDENTIALS`).
- **Git host tokens** — export whichever apply to your repos:
  - `GITHUB_TOKEN` — GitHub PRs
  - `BITBUCKET_TOKEN` — Bitbucket PRs
  - `GITLAB_TOKEN` — GitLab MRs
- **Claude auth** — either be logged in through the `claude` CLI, or export `ANTHROPIC_API_KEY`.

## Quick start

```bash
cd /path/to/your/android-or-kmp/repo
crashfix init                                        # scan repos, write crashfix.config.json, check auth
crashfix run --limit 10 --type anr --min-version 4.2.0
```

`init` discovers the repos under the current directory, writes a `crashfix.config.json` you can edit, and verifies your Firebase / git-host / Claude credentials. `run` then executes the pipeline.

## Fixing specific issues

To bypass the "top issues" fetch and point crashfix at issues you choose:

```bash
crashfix run --issue-url "https://console.firebase.google.com/project/…/issues/5f3a…" \
             --issue-url "https://console.firebase.google.com/project/…/issues/6a1b…"
```

`--issue-url` is repeatable and also accepts a bare issue id. Issues named this
way are always processed, even if the ledger already marks them resolved.

## The wave / pool model

Issues are processed in **waves** of `waveSize` issues; each wave is fully analyzed, fixed, and validated before you review it, then the next wave starts. Within a wave, up to `concurrency` issues run in parallel, each in its own **pool slot** — a reusable set of git worktrees (one per repo) checked out on a throwaway branch. When an issue is approved its work is published and the slot is recycled for the next issue; when it is rejected the branch is deleted and the slot is recycled.

## The ledger and the master document

Every issue crashfix has ever touched is recorded in a **ledger** at
`~/.crashfix/ledger-<project>_<app>.json` (override with `ledgerPath` in the
config). The ledger lives outside your repo and outside `.crashfix/`, so
`crashfix clean` never touches it.

- **No re-work:** on `crashfix run`, any issue the ledger already has in a
  terminal state (`PUSHED`, `PARTIALLY_PUSHED`, `REJECTED`, `UNFIXABLE`) is
  skipped. Issues that previously `FAILED` or never finished are retried.
  Because of this, a run may process fewer than `--limit` issues — raise
  `--limit` to reach deeper into the backlog.
- **Master document:** after every state change crashfix rewrites a single
  Markdown file (`masterDocPath`, default `.crashfix/master.md`) listing every
  ledger issue with its current status, PR links and first/last-seen dates.
  `crashfix status` prints it.

## Reviewing a wave

When a wave finishes, a terminal UI opens with the issue list on the left and the fix detail (diff, analysis, validation output — `tab` cycles panes) on the right:

| Key | Action |
|-----|--------|
| `↑` / `↓` | move between issues |
| `a` | approve |
| `c` | approve **and** attach a comment |
| `r` | reject (prompts for a reason) |
| `s` | skip (decide later) |
| `tab` | switch detail pane |
| `q` | save decisions and quit |
| `Esc` | cancel the comment/reason you are typing |

Approved issues are published immediately; rejected issues have their branch deleted.

## Other commands

- `crashfix resume` — continue an interrupted run from `.crashfix/state.json`.
- `crashfix status` — print the **master issue log** (every issue ever processed, across all runs, with status and PR links), rendered from the ledger.
- `crashfix clean` — remove all crashfix worktrees, `crashfix/*` branches, and `.crashfix/` state. Paths in `cleanExcludes` are never touched.

> **Note:** `crashfix resume` uses the config that was persisted into `.crashfix/state.json` when the run started. Edits to `crashfix.config.json` in the middle of a run are ignored until the next fresh `crashfix run`.

## Configuration reference

`crashfix init` writes `crashfix.config.json`. See `crashfix.config.example.json` for a full 3-repo KMP example.

| Key | Default | Meaning |
|-----|---------|---------|
| `firebase.projectId` | — | Firebase project id |
| `firebase.appId` | — | Crashlytics Android app id |
| `issueSource` | `"firebase"` | which connector to pull issues from (see "adding another issue board") |
| `connectors` | `{ firebase: … }` | map of connector key → MCP stdio server config (`command`, `args`, `env`) |
| `repos` | `[]` | repos to operate on; each: `name`, `path` (relative to config dir), `remote`, `provider` (`github`/`bitbucket`/`gitlab`/`unknown`), `buildCommand` |
| `concurrency` | `4` | max issues worked in parallel within a wave (1–8) |
| `waveSize` | `5` | issues per wave before a review pause (1–10) |
| `validation` | `"build"` | how a fix is checked: `build`, `lint`, or `none` |
| `buildParallelism` | `2` | max repos built concurrently during validation (1–4) |
| `buildTimeoutSec` | `1800` | per-repo build timeout in seconds (min 60) |
| `cleanExcludes` | `[".gradle/", "local.properties", "*.iml"]` | paths `crashfix clean` must never remove |
| `models.orchestrator` | `"opus"` | model alias for the orchestrator |
| `models.fetcher` | `"haiku"` | model alias for issue fetching |
| `models.triager` | `"haiku"` | model alias for triage |
| `models.analyzer` | `"opus"` | model alias for root-cause analysis |
| `models.solver` | `"sonnet"` | model alias for fix generation |
| `models.reviser` | `"sonnet"` | model alias for fix revision after failed validation |
| `models.publisher` | `"haiku"` | model alias for PR/MR creation |
| `models.reporter` | `"haiku"` | model alias for report writing |
| `defaults.limit` | `25` | default value of `--limit` (1–25) |
| `filters.minAppVersion` | `null` | only issues at or above this app version |
| `filters.type` | `null` | restrict to `"crash"` or `"anr"` |
| `filters.minEventCount` | `null` | drop issues with fewer events |
| `filters.since` | `null` | only issues seen since this date |
| `masterDocPath` | `.crashfix/master.md` | where the master issue log is written (relative to the config dir) |
| `ledgerPath` | `~/.crashfix/ledger-<project>_<app>.json` | where the cross-run issue ledger is stored |

CLI flags (`--limit`, `--type`, `--min-version`, `--min-events`, `--since`, `--concurrency`, `--wave-size`, `--source`) override the matching config value for that run.

### Model override example

Run everything but keep the solver on a cheaper model:

```json
{
  "models": { "analyzer": "opus", "solver": "haiku", "reviser": "haiku" }
}
```

Any worker key you omit falls back to its default above.

## Adding another issue board

`crashfix` is not Firebase-only. To pull issues from another tracker (Jira, Sentry, a custom board):

1. Add a `connectors.<key>` entry pointing at any MCP server that exposes list / get-issue tools.
2. Add `src/connectors/<key>.ts` — an adapter that maps that server's responses to the normalized `Issue` shape and registers itself in `connectorRegistry`.
3. Select it with `"issueSource": "<key>"` in the config, or `--source <key>` on the command line.

## `/crashfix` slash command (optional)

To drive `crashfix` from inside Claude Code, drop this into `.claude/commands/crashfix.md`:

```md
---
description: Run the crashfix pipeline
---
Run `crashfix $ARGUMENTS` in the current repo and summarize the master report.
```

## Known limitations

- If a run is interrupted with Ctrl-C in the narrow window between a rejection and the pool slot being torn down, a `crashfix/pool-slot-*` worktree/branch can be left behind. `crashfix clean` removes it.
- If the solver produces no diff for an issue, that issue is marked `FAILED` with the note "solver produced no changes" rather than opening an empty PR.
- The ledger is never garbage-collected. After a project migration, delete the ledger file (or set a new `ledgerPath`) to start fresh.

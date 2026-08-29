# crashfix — automated Crashlytics fix pipeline

**Status:** design approved 2026-08-29
**Type:** greenfield, standalone Node/TypeScript tool

## 1. Purpose

A distributable CLI tool that a mobile dev runs from the root of their Android / KMP
git project. It fetches the top crash/ANR issues from Crashlytics, isolates each in a
git worktree, analyses root cause, generates a code fix, presents a cross-linked local
PR for human review in a terminal UI, and on approval pushes branches and opens real
remote PRs — across all affected repos in a multi-repo project.

The dev triggers it from their AI IDE terminal (Claude Code / Cursor). It authenticates
with the dev's existing Claude credentials via the Claude Agent SDK.

## 2. Non-goals

- Not a Claude Code plugin subagent (subagents cannot spawn subagents; we need a real
  orchestrator). An optional thin `/crashfix` slash command may shell out to the binary.
- Not a CI service. `--yes` CI mode exists but the product is a local dev tool.
- Does not build the full Android app. Validation is lint-only by default.
- Does not merge PRs or touch remote main branches.

## 3. Architecture

```
crashfix (Node/TS binary, @anthropic-ai/claude-agent-sdk)
│
├─ CLI layer        parse flags, load config, resolve run plan
├─ Orchestrator     deterministic JS state machine — fan-out, phase gates, concurrency
│   └─ workers      SDK queries, cwd-scoped to a worktree, model-per-worker
├─ Connectors       pluggable issue sources; default = Firebase MCP
├─ Review TUI       Ink app, launched at the review gate, writes decisions
└─ State store      .crashfix/state.json — pause/resume, idempotent phases
```

Key principle: **control flow is plain JavaScript, not an LLM.** The orchestrator loop
decides nothing with a model — it only sequences phases, spawns workers, and gates on
human input. LLM reasoning happens strictly inside workers.

Runs with `cwd` = the Android/KMP repo root. The repo(s) are the work substrate.
`.crashfix/` is gitignored. Only `crashfix.config.json` is committed to the project.

## 4. Workers and default models

| Worker | Model (default) | Job | Scope |
|---|---|---|---|
| fetcher | Haiku | pull top-N issues from connector, normalize, apply filters | none |
| triager | Haiku | slug + branch name + priority ordering from issue metadata | none |
| analyzer | Opus | stack trace → source, root cause + causation report md | worktree (read-only) |
| solver | Sonnet 5 | edit code, run lint, render diff, write review packet | worktree (read-write) |
| reviser | Sonnet 5 | re-solve given human comments | worktree (read-write) |
| publisher | Haiku | commit message + PR body from causation report, push, open PR | worktree |
| reporter | Haiku | maintain master report md | `.crashfix/` |

All models overridable per worker in config. Orchestrator model default: Opus 4.8
(used for any orchestrator-level LLM step; most orchestration is pure JS).

Worktree creation / removal / branch / push / PR API calls are done by the orchestrator
in plain JS + `git` + provider REST — never by a worker.

## 5. Phases and per-issue state machine

Per-issue status:

```
FETCHED → ANALYZED → SOLVED → IN_REVIEW → APPROVED → PUSHED
                                        → NEEDS_REVISION → SOLVED → …
                                        → REJECTED (not fixed)
any phase → FAILED (stage + error recorded)
analyzer  → UNFIXABLE (not fixed, reason recorded, no worktree)
publish   → PARTIALLY_PUSHED (some repos landed, some failed)
```

1. **Fetch** — fetcher gets N issues (or fewer if fewer exist). Filters applied:
   min app version, type (crash/ANR), min event count, since-date. Write `state.json`.
2. **Setup** — orchestrator creates a coordinated worktree set per issue (§6).
3. **Analyze** — fan out analyzer (concurrency cap), each writes
   `.crashfix/reports/<id>.md`. Reporter links all into `.crashfix/report.md`.
   Analyzer may return `UNFIXABLE` → skip solve, record in report.
4. **Solve** — fan out solver, each edits its worktree, runs lint, writes
   `.crashfix/reviews/<id>.md` (summary + causation link + `git diff` grouped by repo).
5. **Review gate** — launch TUI. Human walks issues: approve / approve+comment /
   reject / skip. Decisions persisted to `state.json`. Ctrl-C / `q` safe here.
6. **Revise loop** — issues with comments → reviser re-runs on the same worktree →
   regenerate review packet → back to TUI (only unresolved issues shown).
7. **Publish** — approved issues: publisher commits + pushes each affected repo's
   branch, opens a PR per repo, two-pass cross-links the PR bodies, embeds the
   causation report. Master report rows → `PUSHED` + PR URLs.
8. **Reject cleanup** — remove every worktree in the set, delete every
   `crashfix/<slug>` branch. Master report row → `NOT FIXED` + reason.
9. **Done** — print summary table + path to master report.

**Resume:** on start, if `state.json` exists, orchestrator replays from the last
completed phase per issue. Every phase is idempotent (re-running a completed phase is
a no-op; re-running a partial phase picks up remaining issues).

## 6. Multi-repo handling

Project structure assumption: **independent nested repos** — A is the root repo;
B, C, D are separate clones checked out into subdirs of A, with A's `.gitignore`
ignoring them. (Not submodules, not a manifest tool.)

**`crashfix init`** (first run, re-runnable): walks subdirs, finds git roots via
`git rev-parse --show-toplevel`, reads each repo's remote URL, infers provider
(github / bitbucket / gitlab) from the URL, writes a draft `repos` block, and asks
the human to confirm names and providers.

```jsonc
"repos": [
  { "name": "A", "path": ".",              "remote": "origin", "provider": "github" },
  { "name": "B", "path": "shared/network", "remote": "origin", "provider": "bitbucket" },
  { "name": "C", "path": "shared/ui",      "remote": "origin", "provider": "bitbucket" }
]
```

**Coordinated worktree set** per issue: worktree of A at
`.crashfix/worktrees/<id>/` on branch `crashfix/<slug>`; each nested repo gets
`git worktree add` into its matching subpath, **same branch name**. The solver sees
one normal assembled project tree and edits across it freely.

**Affected-repo detection:** after solve, `git status --porcelain` in each repo
worktree → the set of repos with changes for that issue.

**Review packet:** a single md file, diff sections grouped `## Repo A` / `## Repo B`,
with **one decision block for the whole issue**. Human approves or rejects the fix as
one logical unit spanning all affected repos.

**Publish:** for each affected repo — commit (message from publisher), push branch,
open PR via that repo's provider API. Two-pass: create all PRs first, then patch each
body to cross-link its siblings ("Part of crashfix issue `<id>`; companion PRs: …")
and embed the causation report. Master report row lists every PR URL.

**Reject:** remove all worktrees in the set, delete all `crashfix/<slug>` branches
across affected repos.

**Partial push failure:** issue → `PARTIALLY_PUSHED`; master report shows which repos
landed. No auto-rollback — human decides.

## 7. Config — `crashfix.config.json`

```jsonc
{
  "firebase": { "projectId": "…", "appId": "1:…:android:…" },  // or auto from google-services.json
  "issueSource": "firebase",
  "connectors": {
    "firebase": {
      "mcp": { "command": "npx", "args": ["-y", "firebase-tools", "experimental:mcp"] }
    }
  },
  "repos": [ /* §6 */ ],
  "concurrency": 4,                 // 1..8
  "validation": "lint",            // lint | none | test
  "models": {
    "orchestrator": "claude-opus-4-8",
    "fetcher": "claude-haiku-4-5",
    "triager": "claude-haiku-4-5",
    "analyzer": "claude-opus-4-8",
    "solver": "claude-sonnet-5",
    "reviser": "claude-sonnet-5",
    "publisher": "claude-haiku-4-5",
    "reporter": "claude-haiku-4-5"
  },
  "defaults": { "limit": 25 },
  "filters": { "minAppVersion": null, "type": null, "minEventCount": null, "since": null }
}
```

**Adding another issue board later:** add a `connectors.<key>` entry pointing at any
MCP server that exposes list-issues / get-issue tools, plus a small adapter
(`src/connectors/<key>.ts`) mapping its fields to the normalized issue shape. Select
it with `issueSource` in config or `--source <key>` at runtime.

Config is validated with a zod schema on load; unknown keys warn, invalid values
hard-fail with the offending path.

## 8. CLI surface

```
crashfix init                 scan repos, write/refresh config, verify Firebase + MCP auth
crashfix run [opts]           full pipeline
crashfix resume               continue from state.json
crashfix status               print master report summary
crashfix clean                remove all worktrees / crashfix branches / .crashfix state

run opts:
  --limit N              default 25 (or config.defaults.limit)
  --min-version 4.2.0
  --type crash|anr
  --min-events 100
  --since 2026-08-01
  --concurrency 4..8
  --source <connector key>   default config.issueSource
  --dry-run                  fetch + analyze only; no worktrees, no edits
  --yes                      skip TUI, auto-approve all (CI mode)
```

**Normalized issue shape** (connector contract):

```ts
interface Issue {
  id: string;
  title: string;
  subtitle: string;
  type: 'crash' | 'anr';
  eventCount: number;
  userCount: number;
  firstSeenVersion: string;
  lastSeenVersion: string;
  stackTrace: string;
  sampleEventUrl: string;
  blameFile?: string;
}
```

## 9. Review TUI (Ink)

- **Left pane:** issue list with status glyphs
  (`● analyzed`, `✎ solved`, `▸ in review`, `✓ approved`, `✗ rejected`, `⚠ failed`),
  sorted by priority from the triager.
- **Right pane:** tabs —
  - `Summary`: causation, root cause, affected repos, lint result.
  - `Diff`: syntax-highlighted, grouped by repo, scrollable.
- **Keys:** `↑↓` navigate · `a` approve · `c` approve + comment (opens `$EDITOR`) ·
  `r` reject (prompts reason) · `s` skip · `d` / `tab` toggle pane · `q` save + quit.
- On quit, decisions persist. `crashfix resume` runs revise / publish / reject, then
  re-opens the TUI if revision produced new items to review.

## 10. Error handling

- **Per-issue failure isolation:** one issue failing marks it `FAILED` (stage + error);
  all other issues continue.
- **Worker retries:** 1 retry on transient API errors (429 / 500), then `FAILED`.
- **Analyzer `UNFIXABLE`:** valid outcome — report row `NOT FIXED (unfixable: <reason>)`,
  no worktree created.
- **Lint failure in solver:** solver gets 1 self-correction pass; if still failing, the
  review packet is flagged `⚠ lint failing` and the human still decides.
- **Dirty base repo:** `run` refuses if any repo has uncommitted changes to files it
  would touch; `--force` overrides.
- **Pre-existing worktree / branch** (prior aborted run): detected; human offered reuse
  or `crashfix clean`.
- **MCP / Firebase auth failure:** hard fail at `init` or fetch, with fix instructions.
- **State corruption:** `state.json` is schema-versioned and validated on load; a
  `state.json.bak` is written before each phase transition.

## 11. Testing

- **Unit (vitest):** config load/validate, repo-map discovery, file→repo routing, diff
  grouping, slug / branch naming, state-machine transitions, connector normalization,
  PR cross-link body patching. Git and the SDK are behind interfaces with fakes.
- **Integration:** temp dir containing nested throwaway git repos + fixture Crashlytics
  JSON + a stub connector; run the pipeline through `--dry-run`, and through solve with
  a scripted fake solver; assert on worktrees, report files, and `state.json`.
- **No live Firebase and no live Anthropic calls in tests** — connector and SDK are
  interface-bound and faked.
- **Manual smoke:** real KMP repo, `crashfix run --limit 2 --dry-run`.

## 12. Project layout

```
crashfix/
  package.json  tsconfig.json  vitest.config.ts
  src/
    cli.ts                    flags, subcommands
    config.ts                 load + zod schema
    orchestrator/
      run.ts                  state-machine loop
      phases/                 fetch.ts analyze.ts solve.ts review.ts revise.ts publish.ts reject.ts
      worktrees.ts            coordinated set create / remove
      reposcan.ts             init discovery
    workers/
      spawn.ts                SDK query wrapper — model resolve, cwd scope, retry
      prompts/                per-worker system prompts (*.md)
    connectors/
      index.ts contract.ts firebase.ts
    publish/
      github.ts bitbucket.ts gitlab.ts crosslink.ts
    tui/                       Ink app
    state.ts  report.ts  git.ts
  test/
```

## 13. Open questions deferred to implementation

- Exact Firebase MCP tool names / response shapes — pin during connector build against
  the installed `firebase-tools` version.
- Whether `git worktree add` for a repo at path `.` plus nested-repo worktrees needs a
  wrapper dir to avoid A's worktree clobbering the nested checkouts — resolve in
  `worktrees.ts` with an integration test.
- Provider PR API auth: reuse `gh` / `glab` CLIs if present, else PAT from env.

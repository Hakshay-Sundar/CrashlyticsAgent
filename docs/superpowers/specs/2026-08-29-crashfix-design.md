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
| solver | Sonnet 5 | edit code, run validation (§6a), render diff, write review packet | worktree (read-write) |
| reviser | Sonnet 5 | re-solve given human comments | worktree (read-write) |
| publisher | Haiku | commit message + PR body from causation report, push, open PR | worktree |
| reporter | Haiku | maintain master report md | `.crashfix/` |

All models overridable per worker in config. Orchestrator model default: Opus 4.8
(used for any orchestrator-level LLM step; most orchestration is pure JS).

Worktree creation / removal / branch / push / PR API calls are done by the orchestrator
in plain JS + `git` + provider REST — never by a worker.

## 5. Phases and per-issue state machine

### 5.0 Wave batching + worktree pool

The dev may request up to `--limit` issues (default 25), but the local machine is
resource-constrained (disk for worktrees, RAM/CPU for gradle). The orchestrator keeps
a **fixed pool of `waveSize` (default 5) coordinated worktree sets** for the entire
run and processes issues in **waves of `waveSize`**.

- **Pool created once** at run start: `waveSize` worktree sets (§6), each = repo A +
  every nested repo, `git worktree add`ed.
- **Slot assignment:** each issue is bound to a free pool slot. The slot is reset to a
  clean base before use — across every repo in the set:
  `git checkout -B crashfix/<slug> <base>` then `git reset --hard <base>` +
  `git clean -fdx` (with a config `cleanExcludes` for local caches like
  `.gradle/`, `local.properties`).
- **A wave** runs the full pipeline for its ≤5 issues — setup (reset slot) → analyze →
  solve → review → publish/reject. On issue completion the slot returns to the pool
  and is reset for the next issue. **Worktrees are not removed between issues or
  waves.**
- **Pool removed only at run end** (or via `crashfix clean`): `git worktree remove`
  all sets, prune, delete leftover local `crashfix/*` branches. Pushed branches remain
  on the remote.

The master report accumulates across all waves; the human reviews one wave at a time.

`waveSize` ≥ `concurrency` is pointless (workers idle); `crashfix` warns if
`concurrency > waveSize` and effectively caps concurrency at `waveSize`.

Resume re-enters at the wave and phase where it stopped, **reusing the existing pool
worktrees** if present (else recreating them).

### 5.1 Per-issue state machine

Per-issue status:

```
FETCHED → ANALYZED → SOLVED → IN_REVIEW → APPROVED → PUSHED
                                        → NEEDS_REVISION → SOLVED → …
                                        → REJECTED (not fixed)
any phase → FAILED (stage + error recorded)
analyzer  → UNFIXABLE (not fixed, reason recorded, no worktree)
publish   → PARTIALLY_PUSHED (some repos landed, some failed)
```

1. **Fetch** — fetcher gets up to `--limit` issues (or fewer if fewer exist). Filters
   applied: min app version, type (crash/ANR), min event count, since-date. Split into
   waves of `waveSize`. Write `state.json`. (Runs once; later phases loop per wave.)
2. **Setup** — bind each wave issue to a free pool slot and reset that slot to a clean
   `crashfix/<slug>` branch off base (§5.0). Pool slots are created on the first wave
   and reused thereafter.
3. **Analyze** — fan out analyzer (concurrency cap), each writes
   `.crashfix/reports/<id>.md`. Reporter links all into `.crashfix/report.md`.
   Analyzer may return `UNFIXABLE` → skip solve, record in report.
4. **Solve** — fan out solver (concurrency cap), each edits its worktree, then runs
   validation (§6a). The validate step drains through a global semaphore
   (`buildParallelism`, default 2) — solve edits run at concurrency N, but at most 2
   gradle builds execute at once. The model is idle during a build (no token cost),
   so a worker simply awaits its build slot. Solver then writes
   `.crashfix/reviews/<id>.md` (summary + causation link + validation result +
   `git diff` grouped by repo).
5. **Review gate** — launch TUI. Human walks issues: approve / approve+comment /
   reject / skip. Decisions persisted to `state.json`. Ctrl-C / `q` safe here.
6. **Revise loop** — issues with comments → reviser re-runs on the same worktree →
   regenerate review packet → back to TUI (only unresolved issues shown).
7. **Publish** — approved issues: publisher commits + pushes each affected repo's
   branch, opens a PR per repo, two-pass cross-links the PR bodies, embeds the
   causation report. Master report rows → `PUSHED` + PR URLs.
8. **Reject cleanup** — release the slot (reset to base on next use), delete the local
   `crashfix/<slug>` branch. Worktree stays in the pool. Master report row →
   `NOT FIXED` + reason.
9. **Wave rollover** — completed issues' slots return to the pool. Loop to step 2 for
   the next wave, if any. No worktree removal.
10. **Done** — remove the entire pool (`git worktree remove` all sets, prune, delete
    leftover local `crashfix/*` branches). Print summary table across all waves + path
    to master report. Pushed remote branches/PRs are untouched.

**Resume:** on start, if `state.json` exists, orchestrator replays from the last
completed phase per issue, within the wave where it stopped. Every phase is idempotent
(re-running a completed phase is a no-op; re-running a partial phase picks up remaining
issues). `state.json` records the fetched issue list, wave assignment, and per-issue
status, so resume never re-fetches.

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

**Coordinated worktree set** (pool slot): worktree of A at
`.crashfix/worktrees/slot-<n>/`; each nested repo gets `git worktree add` into its
matching subpath, **same branch name**. When a slot is assigned an issue, every repo
in the set is switched to `crashfix/<slug>` off base and cleaned (§5.0). The solver
sees one normal assembled project tree and edits across it freely.
Slots are numbered `slot-0 … slot-(waveSize-1)`, not per-issue, since they are reused.

**Affected-repo detection:** after solve, `git status --porcelain` in each repo
worktree → the set of repos with changes for that issue.

**Review packet:** a single md file, diff sections grouped `## Repo A` / `## Repo B`,
with **one decision block for the whole issue**. Human approves or rejects the fix as
one logical unit spanning all affected repos.

**Publish:** for each affected repo — commit (message from publisher), push branch,
open PR via that repo's provider API. Two-pass: create all PRs first, then patch each
body to cross-link its siblings ("Part of crashfix issue `<id>`; companion PRs: …")
and embed the causation report. Master report row lists every PR URL.

**Reject:** delete the local `crashfix/<slug>` branch in every repo of the set; the
slot's worktrees stay in the pool and are reset on next assignment. Nothing was pushed.

**Partial push failure:** issue → `PARTIALLY_PUSHED`; master report shows which repos
landed. No auto-rollback — human decides.

## 6a. Validation

After a solver edits its worktree it validates the fix. Default: **full build**.

- `validation`: `build` (default) | `lint` | `none`.
- `build` runs each affected repo's configured build command (e.g.
  `./gradlew :app:assembleDebug` or a KMP `compileKotlin` task) in the worktree.
- `buildParallelism` (default `2`): global semaphore. Solve *edits* run at
  `concurrency` (4–8); at most `buildParallelism` builds run concurrently. The 4
  parallel solve workers reach their build phase at different times, so a 2-slot
  queue keeps machine load bounded without much stall. A worker `await`s its slot —
  no LLM tokens are spent while a build runs.
- Build command per repo comes from config (`repos[].buildCommand`), falling back to
  autodetected gradle wrapper + module.
- Outcome (`pass` / `fail` + captured output tail) goes into the review packet and
  the master report. A failing build does not block review — the human still decides
  (see §10).

## 6b. Master report — `.crashfix/report.md`

Maintained by the reporter worker, updated after every phase. One row per issue, plus
links to the per-issue causation report.

| column | source |
|---|---|
| issue id / title / type | connector |
| event count / user count / affected versions | connector |
| status | state machine (`ANALYZED`, `PUSHED`, `NOT FIXED`, `PARTIALLY_PUSHED`, `FAILED`, …) |
| branch | `crashfix/<slug>` |
| slot | pool slot that processed it |
| affected repos | affected-repo detection |
| causation report | link to `.crashfix/reports/<id>.md` (root cause + analysis) |
| review packet | link to `.crashfix/reviews/<id>.md` (diff + human decision + comments) |
| PR URLs | one per affected repo, after publish |
| build result | pass / fail (tail) |
| notes | reject reason / unfixable reason / failure stage |

Because worktrees are deleted at run end, the report + the two per-issue md files are
the durable record — they retain the branch name, the diff, and the PR links so a
human can find the work later.

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
  "repos": [ /* §6; each may add "buildCommand": "./gradlew :app:assembleDebug" */ ],
  "concurrency": 4,                 // 1..8, effectively capped at waveSize
  "waveSize": 5,                    // pool size: worktree sets alive at once + issues per wave
  "cleanExcludes": [".gradle/", "local.properties", "*.iml"],  // kept across slot resets
  "validation": "build",           // build | lint | none
  "buildParallelism": 2,           // max concurrent builds across worktrees
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
  --wave-size 5              issues per wave (default config.waveSize)
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
  - `Summary`: causation, root cause, affected repos, build/validation result.
  - `Diff`: syntax-highlighted, grouped by repo, scrollable.
- **Keys:** `↑↓` navigate · `a` approve · `c` approve + comment (opens `$EDITOR`) ·
  `r` reject (prompts reason) · `s` skip · `d` / `tab` toggle pane · `q` save + quit.
- Skipped issues stay `IN_REVIEW` and are re-presented on the next TUI open
  (`resume` or post-revision). The run does not finish while any issue is `IN_REVIEW`.
- On quit, decisions persist. `crashfix resume` runs revise / publish / reject, then
  re-opens the TUI if any issue is still `IN_REVIEW` or revision produced new items.

## 10. Error handling

- **Per-issue failure isolation:** one issue failing marks it `FAILED` (stage + error);
  all other issues continue.
- **Worker retries:** 1 retry on transient API errors (429 / 500), then `FAILED`.
- **Analyzer `UNFIXABLE`:** valid outcome — report row `NOT FIXED (unfixable: <reason>)`,
  no worktree created.
- **Validation (build/lint) failure in solver:** solver gets 1 self-correction pass
  (re-reads build output, edits again, re-queues for a build slot); if still failing,
  the review packet is flagged `⚠ build failing` with the output tail and the human
  still decides.
- **Build timeout:** per-build wall-clock cap (`buildTimeoutSec`, default 1800);
  on timeout the validation result is `fail (timeout)`.
- **Dirty base repo:** `run` refuses if any repo has uncommitted changes to files it
  would touch; `--force` overrides.
- **Pre-existing pool worktrees** (prior aborted run): expected on `resume` — reused
  after a hard reset. On a fresh `run` (no `state.json`), the human is offered reuse
  or `crashfix clean`.
- **Slot reset failure** (clean/checkout fails, e.g. locked file): slot quarantined,
  its worktrees rebuilt from scratch; if that also fails, wave shrinks by one slot
  and a warning is logged (no silent capacity loss).
- **MCP / Firebase auth failure:** hard fail at `init` or fetch, with fix instructions.
- **State corruption:** `state.json` is schema-versioned and validated on load; a
  `state.json.bak` is written before each phase transition.

## 11. Testing

- **Unit (vitest):** config load/validate, repo-map discovery, file→repo routing, diff
  grouping, slug / branch naming, state-machine transitions, connector normalization,
  PR cross-link body patching, build-queue semaphore (never exceeds
  `buildParallelism`, releases slot on error/timeout), wave splitting + wave-loop
  resume, pool slot assignment + reset (never exceeds `waveSize`, `cleanExcludes`
  honored, quarantine on reset failure). Git and the SDK are behind interfaces with
  fakes.
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
      pool.ts                 worktree-set pool: create, assign, reset slot, destroy
      worktrees.ts            single coordinated set create / remove / reset
      buildqueue.ts           validation semaphore (buildParallelism)
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
- Whether `git worktree add` for a repo at path `.` plus nested-repo worktrees (all
  under `.crashfix/worktrees/slot-<n>/`) needs a wrapper dir to avoid A's worktree
  clobbering the nested checkouts — resolve in `worktrees.ts` with an integration test.
- Slot reset strategy: `git checkout -B` + `reset --hard` + `clean -fdx` vs. a full
  worktree rebuild per issue — measure which is faster on a real KMP repo; the pool
  design assumes reset is cheaper.
- Provider PR API auth: reuse `gh` / `glab` CLIs if present, else PAT from env.

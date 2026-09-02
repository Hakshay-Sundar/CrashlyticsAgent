# crashfix — cross-run ledger, master document, explicit URL input

Date: 2026-09-03
Status: design approved, pending spec review

## Problem

`crashfix` has no memory across runs:

1. There is no single document that tracks the status of every issue ever
   processed. `.crashfix/report.md` is regenerated from `state.json`, and
   `fetchPhase` wipes `state.issues` on every fresh `run`, so historical issues
   vanish from the report.
2. Nothing records which Crashlytics issues/URLs have already been fetched, so a
   later run re-fetches and re-processes issues that were already pushed or
   rejected.
3. There is no way to point the pipeline at a specific list of Crashlytics
   issues; it always calls the connector's "list top issues" path.

## Solution overview

Introduce one persistent **ledger** file, stored outside `.crashfix/` so it
survives `crashfix clean`. The ledger is the cross-run source of truth for every
issue ever touched and its final disposition. Derive:

- a **master document** rendered from the ledger (config `masterDocPath`),
- **dedup on fetch** — skip issues whose ledger status is terminal,
- and add **`--issue-url`** for explicit, dedup-bypassing issue selection.

## 1. The ledger

### Location

Default: `~/.crashfix/ledger-<key>.json`, where `<key>` is
`sanitize(`${firebase.projectId}_${firebase.appId}`)` and `sanitize` lowercases
and replaces every run of non-`[a-z0-9]` with `-`. When `firebase` is absent
from config, `<key>` is `default`.

Override: config key `ledgerPath` (string, optional). If set and relative, it is
resolved against the config directory (the pipeline `root`); if absolute, used
as-is. `~` at the start is expanded to `os.homedir()`.

The ledger directory is created on first write (`mkdirSync(recursive)`).

### File shape

```jsonc
{
  "version": 1,
  "entries": {
    "<issueId>": {
      "id": "<issueId>",
      "url": "<sampleEventUrl or ''>",
      "title": "<issue title>",
      "type": "crash" | "anr",
      "firstSeenAt": "<ISO8601>",   // set once, when the entry is created
      "lastSeenAt": "<ISO8601>",    // updated every merge
      "status": "<IssueStatus>",    // latest known status
      "prUrls": { "<repo>": "<url>" },
      "branch": "<branch name or ''>"
    }
  }
}
```

`IssueStatus` is the existing union from `src/types.ts`.

### Module: `src/ledger.ts`

```ts
export const LEDGER_VERSION = 1;

export interface LedgerEntry {
  id: string;
  url: string;
  title: string;
  type: IssueType;
  firstSeenAt: string;
  lastSeenAt: string;
  status: IssueStatus;
  prUrls: Record<string, string>;
  branch: string;
}

export interface Ledger {
  version: number;
  entries: Record<string, LedgerEntry>;
}

/** Resolve the ledger file path from config + root. */
export function ledgerPathFor(cfg: CrashfixConfig, root: string): string;

/** Read the ledger, or return an empty one if the file does not exist.
 *  Throws on a corrupt file or a version mismatch (same policy as loadState). */
export function loadLedger(path: string): Ledger;

/** Atomic write (tmp + rename), mkdir -p the parent. No `.bak` copy. */
export function saveLedger(path: string, ledger: Ledger): void;

/** Merge every record of a RunState into the ledger in place:
 *  - create an entry (setting firstSeenAt) if none exists for the id
 *  - always refresh lastSeenAt, title, type, status, prUrls, branch, url
 *  Returns the same ledger object. */
export function mergeState(ledger: Ledger, state: RunState): Ledger;

/** Terminal statuses for dedup. */
export const TERMINAL_STATUSES: ReadonlySet<IssueStatus>;
// = { 'PUSHED', 'PARTIALLY_PUSHED', 'REJECTED', 'UNFIXABLE' }

/** True when the id has a ledger entry in a terminal status. */
export function isDone(ledger: Ledger, issueId: string): boolean;
```

`url` on an entry comes from `issue.sampleEventUrl`.

Corrupt-file / version-mismatch handling mirrors `loadState`: throw a message
naming the path. There is no `.bak` for the ledger (it is derived data — it can
be rebuilt by re-running, and it is not edited mid-run the way `state.json` is).

## 2. Master document

### Config

`src/config.ts`:

- add `masterDocPath: z.string().default('.crashfix/master.md')`
- add `ledgerPath: z.string().optional()`
- add both keys to `KNOWN_TOP_LEVEL_KEYS`

`masterDocPath`, if relative, resolves against `root`.

### Renderer

`src/report.ts`: add

```ts
export function renderMaster(ledger: Ledger): string;
export function writeMaster(path: string, ledger: Ledger): void;
```

`renderMaster` output:

```
# crashfix — master issue log

_Last updated: <ISO8601>_

## Summary

- <status>: <count>
  ...

| Issue | Type | Status | First seen | Last seen | PRs | URL |
|---|---|---|---|---|---|---|
| <id> — <title> | <type> | <status> | <date> | <date> | [repo](url) ... | [link](url) |
...
```

Rows sorted by `lastSeenAt` descending (most recently touched first). `First
seen` / `Last seen` render the date portion of the ISO timestamp only. Cell
escaping reuses the existing `cell()` helper approach from `renderReport` (`|` →
`\|`, newlines → space).

`renderReport` and `.crashfix/report.md` (`writeReport`) are unchanged — the
per-run console summary at the end of `run` / `resume` still uses `renderReport`.

### Wiring

`persist()` appears twice — `src/orchestrator/phases.ts` and
`src/orchestrator/run.ts`. Both currently do `saveState` + `writeReport`. Change
both to also:

```ts
mergeState(d.ledger, state);
saveLedger(d.ledgerPath, d.ledger);
writeMaster(d.masterDocPath, d.ledger);
```

`run.ts`'s free `persist(root, state)` helper needs access to the ledger; it
gains the extra params (or is folded into a closure created in `core` that has
`d`). Implementation detail for the plan — the requirement is that every
`persist` refreshes ledger + master doc.

**Dry-run** (`crashfix run --dry-run`) is a preview and must NOT touch the
ledger: `dryAnalyze`'s `persist` still writes `state.json` + `report.md` but
skips `mergeState`/`saveLedger`/`writeMaster`. Implementation: the dry-run path
uses a persist variant without the ledger step, or passes a flag.

Because live records are merged into the ledger before every render, the master
doc shows in-progress issues at their live status immediately; only terminal
entries are "frozen" for dedup purposes, and they still re-render each time.

## 3. Dedup on fetch

`fetchPhase` (`src/orchestrator/phases.ts`):

```ts
export async function fetchPhase(d: Deps, state: RunState, refs?: string[]): Promise<void>
```

- When `refs` is non-empty (explicit URL mode): call
  `d.connector.fetchIssuesByRef(refs)`; **do not** apply the dedup filter.
- Otherwise: call `d.connector.fetchTopIssues(...)` as today, then filter:
  `issues.filter((i) => !isDone(d.ledger, i.id))`.

The `ranked`/`slice(limit)` logic is unchanged and runs on the filtered list.
After filtering the wave may be smaller than `--limit`; that is acceptable
(documented in the README). No backfill fetch.

If, after filtering (or from `fetchIssuesByRef`), zero issues remain,
`fetchPhase` still proceeds — `state.issues` is `{}`, `waveOrder` is `[]`, the
wave loop is a no-op, the run completes, and the master doc is still refreshed.
`run` prints "no new issues to process" in that case.

## 4. Explicit URL input

### Connector contract

`src/connectors/contract.ts`:

```ts
export interface Connector {
  key: string;
  fetchTopIssues(params: FetchParams): Promise<Issue[]>;
  fetchIssuesByRef?(refs: string[]): Promise<Issue[]>;
}
```

`refs` entries are Crashlytics issue URLs or bare issue ids. A helper
`parseIssueRef(ref: string): string` extracts the id: for a URL, the last path
segment after `/issues/`; otherwise the trimmed string.

### firebase connector

`src/connectors/firebase.ts`: implement `fetchIssuesByRef`. Same worker/prompt
machinery as `fetchTopIssues`, but the prompt instructs: "for each of these
issue ids: `<ids>`, fetch full metadata and a representative stack trace via the
Crashlytics MCP `get_issue` / sample-events tools", same JSON output contract,
same `issueSchema` validation. Preserve the original `url` by setting
`sampleEventUrl` to the caller-supplied ref when the model omits it.

### fake connector

`src/connectors/fake.ts`: implement `fetchIssuesByRef` — return the seeded
issues whose `id` equals a parsed ref or whose `sampleEventUrl` includes the raw
ref string.

### CLI

`src/cli.ts`, `run` command: add

```ts
.option('--issue-url <url>', 'analyse a specific Crashlytics issue (repeatable)',
        (v, acc: string[]) => (acc.push(v), acc), [])
```

`src/config.ts` `RunCliOptions`: add `issueUrl?: string[]`.

`src/cli/run.ts` `runCommand`: pass `issueUrl` through to `runPipeline`.

### Threading

`refs` flows: `runCommand(opts.issueUrl)` → `runPipeline({ ..., refs })` →
`core(..., { refs })` → `fetchPhase(d, state, refs)`.

`RunPipelineOptions` (`src/orchestrator/run.ts`) gains `refs?: string[]`.

When `refs` is non-empty and `d.connector.fetchIssuesByRef` is undefined,
`fetchPhase` throws: `` `issue source "${d.connector.key}" does not support --issue-url` ``.

`resume` never re-runs `fetchPhase` (state.phase is past `fetch`), so `refs` is
irrelevant on resume — not plumbed through `resumePipeline`.

## 5. `crashfix status`

`src/cli/status.ts`: load the ledger (via `ledgerPathFor(cfg, cwd)` — needs
`loadConfig`) and print `renderMaster(ledger)`. When the ledger file does not
exist, print `no issues recorded yet`.

`status` no longer depends on `.crashfix/state.json`.

## 6. `Deps` additions

`src/orchestrator/phases.ts` `Deps` interface gains:

```ts
ledger: Ledger;
ledgerPath: string;
masterDocPath: string;
```

`src/orchestrator/run.ts` `core()` builds them:

```ts
const ledgerPath = ledgerPathFor(cfg, root);
const ledger = loadLedger(ledgerPath);
const masterDocPath = isAbsolute(cfg.masterDocPath)
  ? cfg.masterDocPath : join(root, cfg.masterDocPath);
const d: Deps = { ...raw, root, cfg, pool, sem, base, ledger, ledgerPath, masterDocPath };
```

`RunPipelineOptions['deps']` is `Omit<Deps, 'root'|'cfg'|'pool'|'sem'|'base'>` —
extend the omit to also exclude `ledger|ledgerPath|masterDocPath` so
`buildDeps` in `cli/run.ts` does not need to supply them.

## Out of scope (YAGNI)

- `--retry <id>` flag — use `--issue-url` to force reprocessing of a terminal issue.
- `crashfix clean --forget` — delete the ledger file by hand.
- Backfilling the fetch to reach `--limit` fresh issues after dedup.
- Migrating/merging ledgers across project ids.
- A `.bak` copy of the ledger.

## Testing

New `crashfix/test/ledger.test.ts`:

- `ledgerPathFor`: key derived from firebase config; `default` when absent; `~`
  expansion; relative resolves against root; absolute passes through.
- `loadLedger`: missing file → empty ledger; corrupt → throws; version mismatch
  → throws.
- `saveLedger` + `loadLedger` round-trip; parent dir created.
- `mergeState`: new id gets `firstSeenAt`; existing id keeps original
  `firstSeenAt`, refreshes `lastSeenAt`/status/prUrls/branch.
- `isDone` / `TERMINAL_STATUSES`: true only for the four terminal statuses.

Extend:

- `test/config.test.ts`: `masterDocPath` default + override, `ledgerPath`
  optional, both accepted as known keys.
- `test/report.test.ts`: `renderMaster` — summary counts, row per entry, sort by
  `lastSeenAt` desc, PR links, `|` escaping.
- `test/connectors/firebase.test.ts`: `fetchIssuesByRef` parses ids from URLs,
  validates via `issueSchema`, backfills `sampleEventUrl` from the ref.
- `test/connectors/registry.test.ts` or a fake test: `fetchIssuesByRef` on the
  fake connector matches by id and by URL substring.
- `test/orchestrator/phases.test.ts`:
  - `fetchPhase` with a ledger containing a terminal entry drops that issue.
  - `fetchPhase` with a non-terminal (`FAILED`) ledger entry keeps that issue.
  - `fetchPhase` with `refs` calls `fetchIssuesByRef`, skips the dedup filter,
    and throws when the connector lacks the method.
  - `persist` writes the ledger file and the master doc.
- `test/e2e/pipeline.e2e.test.ts`: after a full run, assert the ledger file
  exists outside `.crashfix/`, the master doc exists, and a second run in the
  same fixture skips the already-`PUSHED` issue.

## Rollout / compatibility

- No state.json version bump (`RunState` shape unchanged).
- First run after upgrade: ledger file does not exist → created; nothing is
  skipped (empty ledger), so behaviour matches today plus a new master doc.
- Existing `.crashfix/report.md` keeps being written; `master.md` is additive.

# crashfix — Ledger, Master Doc & Explicit URL Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `crashfix` cross-run memory: one persistent ledger of every Crashlytics issue ever processed, a single master status document rendered from it, automatic skip of already-resolved issues on fetch, and a `--issue-url` flag to point the pipeline at specific issues.

**Architecture:** A new `src/ledger.ts` module owns a JSON file stored under `~/.crashfix/` (outside the repo, survives `crashfix clean`). Every `persist()` in the orchestrator merges the live `RunState` into the ledger, saves it, and re-renders a Markdown master doc. `fetchPhase` filters connector output against the ledger's terminal-status entries. A new optional connector method `fetchIssuesByRef` resolves explicit issue URLs/ids, bypassing both the top-issues fetch and the dedup filter.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod for config, Vitest for tests, Commander for CLI. Node >= 20.

**Spec:** [docs/superpowers/specs/2026-09-03-crashfix-ledger-and-master-doc.md](../specs/2026-09-03-crashfix-ledger-and-master-doc.md)

## Global Constraints

- Node >= 20, TypeScript ESM with `.js` import specifiers (NodeNext resolution).
- All file writes that must not corrupt on crash use tmp-file + `renameSync` (follow `src/state.ts`).
- Corrupt-file / version-mismatch handling throws an `Error` whose message names the path (follow `loadState` in `src/state.ts`).
- `IssueStatus` union lives in `src/types.ts` — never redefine it.
- `TERMINAL_STATUSES` = exactly `{ 'PUSHED', 'PARTIALLY_PUSHED', 'REJECTED', 'UNFIXABLE' }`.
- Ledger file default path: `~/.crashfix/ledger-<key>.json`, `<key>` = `${projectId}_${appId}` lowercased with every run of non-`[a-z0-9]` replaced by `-`; `default` when `firebase` config is absent.
- `masterDocPath` config default: `.crashfix/master.md` (resolved against the pipeline `root` when relative).
- Tests: Vitest, `describe`/`it`/`expect`, temp dirs via `mkdtempSync(join(tmpdir(), 'cfx-'))`.
- Run the full suite with `npm test` from `crashfix/`; type-check with `npm run build`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `crashfix/src/ledger.ts` | **new** — ledger types, path resolution, load/save, `mergeState`, dedup predicate | 1 |
| `crashfix/test/ledger.test.ts` | **new** — unit tests for the ledger module | 1 |
| `crashfix/src/config.ts` | add `masterDocPath`, `ledgerPath` keys + `RunCliOptions.issueUrl` | 2 |
| `crashfix/test/config.test.ts` | extend — new config keys | 2 |
| `crashfix/src/report.ts` | add `renderMaster` / `writeMaster` (ledger → Markdown) | 3 |
| `crashfix/test/report.test.ts` | extend — `renderMaster` | 3 |
| `crashfix/src/connectors/contract.ts` | add optional `fetchIssuesByRef` to `Connector`; add `parseIssueRef` helper | 4 |
| `crashfix/src/connectors/firebase.ts` | implement `fetchIssuesByRef` | 4 |
| `crashfix/src/connectors/fake.ts` | implement `fetchIssuesByRef` | 4 |
| `crashfix/test/connectors/firebase.test.ts` | extend — `fetchIssuesByRef` | 4 |
| `crashfix/test/connectors/fake.test.ts` | **new** — fake `fetchIssuesByRef` | 4 |
| `crashfix/src/orchestrator/phases.ts` | `Deps` fields; `persist` writes ledger+master; `fetchPhase(d, state, refs?)` dedup + ref branch | 5 |
| `crashfix/src/orchestrator/run.ts` | `core` builds ledger/paths; `RunPipelineOptions.refs`; thread `refs`; dry-run skips ledger | 5 |
| `crashfix/test/orchestrator/phases.test.ts` | extend — dedup, refs, persist writes ledger | 5 |
| `crashfix/src/cli.ts` | `--issue-url` repeatable option | 6 |
| `crashfix/src/cli/run.ts` | pass `issueUrl` → `runPipeline({ refs })` | 6 |
| `crashfix/src/cli/status.ts` | load ledger, print `renderMaster` | 6 |
| `crashfix/test/cli/status.test.ts` | extend — status prints master doc from ledger | 6 |
| `crashfix/test/e2e/pipeline.e2e.test.ts` | extend — ledger file + master doc created; second run skips PUSHED issue | 7 |
| `crashfix/README.md` | document ledger, master doc, `--issue-url`, dedup behaviour | 7 |

---

## Task 1: Ledger module (`src/ledger.ts`)

**Files:**
- Create: `crashfix/src/ledger.ts`
- Test: `crashfix/test/ledger.test.ts`

**Interfaces:**
- Consumes: `IssueStatus`, `IssueType`, `RunState` from `src/types.js`; `CrashfixConfig` from `src/config.js`.
- Produces:
  - `LEDGER_VERSION: number` (= 1)
  - `interface LedgerEntry { id: string; url: string; title: string; type: IssueType; firstSeenAt: string; lastSeenAt: string; status: IssueStatus; prUrls: Record<string, string>; branch: string }`
  - `interface Ledger { version: number; entries: Record<string, LedgerEntry> }`
  - `ledgerPathFor(cfg: CrashfixConfig, root: string): string`
  - `loadLedger(path: string): Ledger`
  - `saveLedger(path: string, ledger: Ledger): void`
  - `mergeState(ledger: Ledger, state: RunState): Ledger`
  - `TERMINAL_STATUSES: ReadonlySet<IssueStatus>`
  - `isDone(ledger: Ledger, issueId: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `crashfix/test/ledger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  ledgerPathFor, loadLedger, saveLedger, mergeState, isDone,
  TERMINAL_STATUSES, LEDGER_VERSION, type Ledger,
} from '../src/ledger.js';

const empty = (): Ledger => ({ version: LEDGER_VERSION, entries: {} });

describe('ledgerPathFor', () => {
  it('derives the key from firebase projectId/appId', () => {
    const p = ledgerPathFor({ firebase: { projectId: 'My.App', appId: '1:22:android:xyz' } } as any, '/r');
    expect(p).toBe(join(homedir(), '.crashfix', 'ledger-my-app_1-22-android-xyz.json'));
  });

  it('uses "default" when firebase config is absent', () => {
    const p = ledgerPathFor({} as any, '/r');
    expect(p).toBe(join(homedir(), '.crashfix', 'ledger-default.json'));
  });

  it('honours an absolute ledgerPath override', () => {
    expect(ledgerPathFor({ ledgerPath: '/tmp/x/led.json' } as any, '/r')).toBe('/tmp/x/led.json');
  });

  it('resolves a relative ledgerPath against root', () => {
    expect(ledgerPathFor({ ledgerPath: 'sub/led.json' } as any, '/r')).toBe(join('/r', 'sub/led.json'));
  });

  it('expands a leading ~ in ledgerPath', () => {
    expect(ledgerPathFor({ ledgerPath: '~/led.json' } as any, '/r')).toBe(join(homedir(), 'led.json'));
  });
});

describe('loadLedger / saveLedger', () => {
  it('returns an empty ledger when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfx-'));
    expect(loadLedger(join(dir, 'nope.json'))).toEqual({ version: LEDGER_VERSION, entries: {} });
  });

  it('round-trips and creates the parent dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfx-'));
    const p = join(dir, 'a', 'b', 'led.json');
    const led = empty();
    led.entries.i1 = {
      id: 'i1', url: 'u', title: 't', type: 'crash',
      firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
      status: 'PUSHED', prUrls: { A: 'x' }, branch: 'crashfix/x',
    };
    saveLedger(p, led);
    expect(existsSync(p)).toBe(true);
    expect(loadLedger(p)).toEqual(led);
  });

  it('throws on a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfx-'));
    const p = join(dir, 'led.json');
    writeFileSync(p, '{ not json');
    expect(() => loadLedger(p)).toThrow(/led\.json/);
  });

  it('throws on a version mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfx-'));
    const p = join(dir, 'led.json');
    writeFileSync(p, JSON.stringify({ version: LEDGER_VERSION + 1, entries: {} }));
    expect(() => loadLedger(p)).toThrow(/version/);
  });
});

describe('mergeState', () => {
  const stateWith = (over: Record<string, unknown>) => ({
    issues: {
      i1: {
        issue: { id: 'i1', title: 'NPE', type: 'crash', sampleEventUrl: 'https://c/i1' },
        status: 'ANALYZED', branch: 'crashfix/npe-i1', prUrls: {}, affectedRepos: [],
        ...over,
      },
    },
  }) as any;

  it('creates an entry with firstSeenAt == lastSeenAt for a new id', () => {
    const led = empty();
    mergeState(led, stateWith({}));
    const e = led.entries.i1;
    expect(e.id).toBe('i1');
    expect(e.url).toBe('https://c/i1');
    expect(e.status).toBe('ANALYZED');
    expect(e.firstSeenAt).toBe(e.lastSeenAt);
  });

  it('keeps the original firstSeenAt and refreshes the rest on an existing id', async () => {
    const led = empty();
    led.entries.i1 = {
      id: 'i1', url: 'https://c/i1', title: 'NPE', type: 'crash',
      firstSeenAt: '2020-01-01T00:00:00.000Z', lastSeenAt: '2020-01-01T00:00:00.000Z',
      status: 'FETCHED', prUrls: {}, branch: 'crashfix/npe-i1',
    };
    mergeState(led, stateWith({ status: 'PUSHED', prUrls: { A: 'https://gh/1' } }));
    const e = led.entries.i1;
    expect(e.firstSeenAt).toBe('2020-01-01T00:00:00.000Z');
    expect(e.lastSeenAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(e.status).toBe('PUSHED');
    expect(e.prUrls).toEqual({ A: 'https://gh/1' });
  });
});

describe('isDone / TERMINAL_STATUSES', () => {
  it('is true only for terminal statuses', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ['PARTIALLY_PUSHED', 'PUSHED', 'REJECTED', 'UNFIXABLE'],
    );
    const led = empty();
    led.entries.done = { status: 'PUSHED' } as any;
    led.entries.failed = { status: 'FAILED' } as any;
    expect(isDone(led, 'done')).toBe(true);
    expect(isDone(led, 'failed')).toBe(false);
    expect(isDone(led, 'missing')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crashfix && npx vitest run test/ledger.test.ts`
Expected: FAIL — `Cannot find module '../src/ledger.js'`.

- [ ] **Step 3: Write the implementation**

Create `crashfix/src/ledger.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { CrashfixConfig } from './config.js';
import type { IssueStatus, IssueType, RunState } from './types.js';

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

export const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  'PUSHED', 'PARTIALLY_PUSHED', 'REJECTED', 'UNFIXABLE',
]);

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const expandTilde = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

export function ledgerPathFor(cfg: CrashfixConfig, root: string): string {
  if (cfg.ledgerPath) {
    const p = expandTilde(cfg.ledgerPath);
    return isAbsolute(p) ? p : join(root, p);
  }
  const key = cfg.firebase
    ? sanitize(`${cfg.firebase.projectId}_${cfg.firebase.appId}`)
    : 'default';
  return join(homedir(), '.crashfix', `ledger-${key}.json`);
}

export function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return { version: LEDGER_VERSION, entries: {} };
  let obj: Ledger;
  try {
    obj = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`corrupt ledger ${path}: ${(e as Error).message}`);
  }
  if (obj.version !== LEDGER_VERSION) {
    throw new Error(`ledger ${path} version ${obj.version} != ${LEDGER_VERSION}`);
  }
  return obj;
}

export function saveLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, path);
}

export function mergeState(ledger: Ledger, state: RunState): Ledger {
  const now = new Date().toISOString();
  for (const rec of Object.values(state.issues)) {
    const id = rec.issue.id;
    const prev = ledger.entries[id];
    ledger.entries[id] = {
      id,
      url: rec.issue.sampleEventUrl ?? prev?.url ?? '',
      title: rec.issue.title,
      type: rec.issue.type,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
      status: rec.status,
      prUrls: rec.prUrls ?? {},
      branch: rec.branch ?? prev?.branch ?? '',
    };
  }
  return ledger;
}

export function isDone(ledger: Ledger, issueId: string): boolean {
  const e = ledger.entries[issueId];
  return !!e && TERMINAL_STATUSES.has(e.status);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd crashfix && npx vitest run test/ledger.test.ts`
Expected: PASS (all cases).

Note: `ledgerPathFor` reads `cfg.ledgerPath` — Task 2 adds it to the schema, but the test passes a plain object cast to `any`, so this task is self-contained.

- [ ] **Step 5: Commit**

```bash
cd crashfix && git add src/ledger.ts test/ledger.test.ts
git commit -m "feat(ledger): cross-run issue ledger module

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Config keys (`masterDocPath`, `ledgerPath`, `issueUrl`)

**Files:**
- Modify: `crashfix/src/config.ts`
- Test: `crashfix/test/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CrashfixConfig` gains `masterDocPath: string` (default `.crashfix/master.md`) and `ledgerPath?: string`. `RunCliOptions` gains `issueUrl?: string[]`.

- [ ] **Step 1: Write the failing test**

Add to `crashfix/test/config.test.ts` inside `describe('loadConfig', ...)`:

```ts
  it('defaults masterDocPath and leaves ledgerPath undefined', () => {
    const dir = writeConfig({ firebase: { projectId: 'p', appId: 'a' } });
    const cfg = loadConfig(dir);
    expect(cfg.masterDocPath).toBe('.crashfix/master.md');
    expect(cfg.ledgerPath).toBeUndefined();
  });

  it('accepts masterDocPath and ledgerPath overrides without an unknown-key warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = writeConfig({
      firebase: { projectId: 'p', appId: 'a' },
      masterDocPath: 'docs/CRASHFIX.md',
      ledgerPath: '~/.crashfix/led.json',
    });
    const cfg = loadConfig(dir);
    expect(cfg.masterDocPath).toBe('docs/CRASHFIX.md');
    expect(cfg.ledgerPath).toBe('~/.crashfix/led.json');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crashfix && npx vitest run test/config.test.ts`
Expected: FAIL — `masterDocPath` is `undefined`; the override test also logs an unknown-key warning.

- [ ] **Step 3: Write the implementation**

In `crashfix/src/config.ts`:

1. Add to the `KNOWN_TOP_LEVEL_KEYS` array: `'masterDocPath'`, `'ledgerPath'`.
2. In the `schema` object (after `cleanExcludes`), add:

```ts
  masterDocPath: z.string().default('.crashfix/master.md'),
  ledgerPath: z.string().optional(),
```

3. In `RunCliOptions`, add:

```ts
  issueUrl?: string[];
```

`mergeCliOverrides` needs no change — `issueUrl` is threaded separately (Task 6), not merged into config.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd crashfix && npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd crashfix && git add src/config.ts test/config.test.ts
git commit -m "feat(config): masterDocPath, ledgerPath, issueUrl option

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Master-doc renderer (`renderMaster` / `writeMaster`)

**Files:**
- Modify: `crashfix/src/report.ts`
- Test: `crashfix/test/report.test.ts`

**Interfaces:**
- Consumes: `Ledger` from `src/ledger.js`.
- Produces:
  - `renderMaster(ledger: Ledger): string`
  - `writeMaster(path: string, ledger: Ledger): void`

- [ ] **Step 1: Write the failing test**

Add to `crashfix/test/report.test.ts`:

```ts
import { renderMaster } from '../src/report.js';
import type { Ledger } from '../src/ledger.js';

const ledger: Ledger = {
  version: 1,
  entries: {
    old: {
      id: 'old', url: 'https://c/old', title: 'stale | crash', type: 'crash',
      firstSeenAt: '2026-01-01T09:00:00.000Z', lastSeenAt: '2026-01-02T09:00:00.000Z',
      status: 'REJECTED', prUrls: {}, branch: 'crashfix/old',
    },
    fresh: {
      id: 'fresh', url: 'https://c/fresh', title: 'NPE in Feed', type: 'crash',
      firstSeenAt: '2026-03-01T09:00:00.000Z', lastSeenAt: '2026-03-05T09:00:00.000Z',
      status: 'PUSHED', prUrls: { app: 'https://gh/pr/7' }, branch: 'crashfix/fresh',
    },
  },
};

describe('renderMaster', () => {
  it('has a summary count per status', () => {
    const md = renderMaster(ledger);
    expect(md).toMatch(/# crashfix — master issue log/);
    expect(md).toMatch(/PUSHED: 1/);
    expect(md).toMatch(/REJECTED: 1/);
  });

  it('renders one row per entry, most-recently-seen first', () => {
    const md = renderMaster(ledger);
    const body = md.slice(md.indexOf('| Issue |'));
    expect(body.indexOf('fresh')).toBeLessThan(body.indexOf('old'));
  });

  it('links PRs and the issue URL and escapes pipes in the title', () => {
    const md = renderMaster(ledger);
    expect(md).toContain('[app](https://gh/pr/7)');
    expect(md).toContain('https://c/fresh');
    expect(md).toContain('stale \\| crash');
  });

  it('renders the date portion of the timestamps', () => {
    const md = renderMaster(ledger);
    expect(md).toContain('2026-03-01');
    expect(md).toContain('2026-03-05');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crashfix && npx vitest run test/report.test.ts`
Expected: FAIL — `renderMaster` is not exported.

- [ ] **Step 3: Write the implementation**

In `crashfix/src/report.ts`, add these imports at the top:

```ts
import type { Ledger } from './ledger.js';
```

and append:

```ts
export function renderMaster(ledger: Ledger): string {
  const esc = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const entries = Object.values(ledger.entries)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;

  const summary = ['## Summary', '', ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`), ''];
  const header = '| Issue | Type | Status | First seen | Last seen | PRs | URL |';
  const sep = '|' + '---|'.repeat(7);
  const rows = entries.map((e) => {
    const prs = Object.entries(e.prUrls).map(([repo, url]) => `[${repo}](${url})`).join(' ');
    const link = e.url ? `[link](${e.url})` : '';
    return `| ${esc(e.id)} — ${esc(e.title)} | ${esc(e.type)} | ${esc(e.status)} | ` +
      `${e.firstSeenAt.slice(0, 10)} | ${e.lastSeenAt.slice(0, 10)} | ${prs} | ${link} |`;
  });

  return [
    '# crashfix — master issue log', '',
    `_Last updated: ${new Date().toISOString()}_`, '',
    ...summary, header, sep, ...rows, '',
  ].join('\n');
}

export function writeMaster(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderMaster(ledger));
}
```

Add `dirname` to the existing `node:path` import: `import { dirname, join } from 'node:path';`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd crashfix && npx vitest run test/report.test.ts`
Expected: PASS (both the new and pre-existing `renderReport` cases).

- [ ] **Step 5: Commit**

```bash
cd crashfix && git add src/report.ts test/report.test.ts
git commit -m "feat(report): renderMaster / writeMaster from the ledger

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Connector `fetchIssuesByRef`

**Files:**
- Modify: `crashfix/src/connectors/contract.ts`, `crashfix/src/connectors/firebase.ts`, `crashfix/src/connectors/fake.ts`
- Test: `crashfix/test/connectors/firebase.test.ts`, `crashfix/test/connectors/fake.test.ts` (new)

**Interfaces:**
- Consumes: existing `Issue`, `issueSchema`, `extractJsonBlock` in `firebase.ts`.
- Produces:
  - `Connector.fetchIssuesByRef?(refs: string[]): Promise<Issue[]>` (optional method on the interface)
  - `parseIssueRef(ref: string): string` exported from `contract.ts`

- [ ] **Step 1: Write the failing tests**

Add to `crashfix/test/connectors/firebase.test.ts`:

```ts
import { parseIssueRef } from '../../src/connectors/contract.js';

describe('parseIssueRef', () => {
  it('pulls the id out of a console URL', () => {
    expect(parseIssueRef(
      'https://console.firebase.google.com/project/x/crashlytics/app/android:y/issues/5f3a9c1e01?time=last-7d',
    )).toBe('5f3a9c1e01');
  });
  it('passes a bare id through, trimmed', () => {
    expect(parseIssueRef('  ABC123  ')).toBe('ABC123');
  });
});

describe('firebaseConnector.fetchIssuesByRef', () => {
  it('resolves each ref and backfills sampleEventUrl from the ref', async () => {
    const url = 'https://console.firebase/app/issues/ABC';
    const json = JSON.stringify({ issues: [{
      id: 'ABC', title: 'NPE Feed', subtitle: '', type: 'crash',
      eventCount: 900, userCount: 40, firstSeenVersion: '4.1.0', lastSeenVersion: '4.3.0',
      stackTrace: 'NPE\n at X.kt:1',
    }] });
    const c = firebaseFactory(deps('```json\n' + json + '\n```'));
    const issues = await c.fetchIssuesByRef!([url]);
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('ABC');
    expect(issues[0].sampleEventUrl).toBe(url);
  });

  it('keeps a model-supplied sampleEventUrl when present', async () => {
    const json = JSON.stringify({ issues: [{
      id: 'ABC', title: 'NPE', subtitle: '', type: 'crash', eventCount: 1, userCount: 1,
      firstSeenVersion: '1', lastSeenVersion: '2', stackTrace: 's',
      sampleEventUrl: 'https://real/url',
    }] });
    const c = firebaseFactory(deps('```json\n' + json + '\n```'));
    const issues = await c.fetchIssuesByRef!(['ABC']);
    expect(issues[0].sampleEventUrl).toBe('https://real/url');
  });
});
```

Create `crashfix/test/connectors/fake.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fakeConnector } from '../../src/connectors/fake.js';
import type { Issue } from '../../src/types.js';

const issue = (over: Partial<Issue>): Issue => ({
  id: 'x', title: 't', subtitle: '', type: 'crash', eventCount: 1, userCount: 1,
  firstSeenVersion: '1', lastSeenVersion: '2', stackTrace: 's', sampleEventUrl: '', ...over,
});

describe('fakeConnector.fetchIssuesByRef', () => {
  const issues = [
    issue({ id: 'a', sampleEventUrl: 'https://c/issues/a' }),
    issue({ id: 'b', sampleEventUrl: 'https://c/issues/b' }),
  ];
  const c = fakeConnector(issues)({} as any);

  it('matches by parsed id', async () => {
    const out = await c.fetchIssuesByRef!(['https://c/issues/a']);
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('matches by raw url substring', async () => {
    const out = await c.fetchIssuesByRef!(['https://c/issues/b']);
    expect(out.map((i) => i.id)).toEqual(['b']);
  });

  it('returns nothing for an unknown ref', async () => {
    expect(await c.fetchIssuesByRef!(['zzz'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd crashfix && npx vitest run test/connectors/firebase.test.ts test/connectors/fake.test.ts`
Expected: FAIL — `parseIssueRef` not exported; `fetchIssuesByRef` undefined.

- [ ] **Step 3: Write the implementation**

In `crashfix/src/connectors/contract.ts`:

```ts
export interface Connector {
  key: string;
  fetchTopIssues(params: FetchParams): Promise<Issue[]>;
  fetchIssuesByRef?(refs: string[]): Promise<Issue[]>;
}

/** Extract a Crashlytics issue id from a console URL, or pass a bare id through. */
export function parseIssueRef(ref: string): string {
  const s = ref.trim();
  const m = /\/issues\/([^/?#]+)/.exec(s);
  return m ? m[1]! : s;
}
```

In `crashfix/src/connectors/firebase.ts`, add `parseIssueRef` to the factory's returned object. Import it: `import type { ConnectorFactory } from './contract.js';` becomes `import { parseIssueRef, type ConnectorFactory } from './contract.js';`. Then inside the returned object, after `fetchTopIssues`:

```ts
    async fetchIssuesByRef(refs) {
      const ids = refs.map(parseIssueRef);
      const prompt = [
        `For each of these Crashlytics issue ids: ${JSON.stringify(ids)}`,
        `(project ${project?.projectId ?? 'configured for this directory'}, app ${project?.appId ?? ''}),`,
        `fetch full issue metadata and a representative stack trace using the Firebase MCP tools`,
        `(likely ${MCP_TOOL_HINTS.join(', ')}; discover the real names at runtime).`,
        `type must be exactly "crash" or "anr" (lowercase).`,
        `Respond with ONLY a fenced \`\`\`json block: {"issues":[{id,title,subtitle,type,`,
        `eventCount,userCount,firstSeenVersion,lastSeenVersion,stackTrace,sampleEventUrl}]}`,
      ].join('\n');

      const { text } = await runWorker({
        worker: 'fetcher',
        model: 'haiku',
        cwd: process.cwd(),
        systemPrompt:
          'You are a data-extraction agent for Firebase Crashlytics. Output only what is asked.',
        prompt,
        allowedTools: ['mcp__firebase'],
        mcpServers: mcp ? { firebase: mcp } : undefined,
      });

      const parsed = extractJsonBlock(text) as { issues?: unknown[] };
      if (!Array.isArray(parsed.issues)) {
        log.warn('fetcher response had no "issues" array', parsed);
        return [];
      }
      const byId = new Map(ids.map((id, i) => [id, refs[i]!]));
      const out: Issue[] = [];
      for (const raw of parsed.issues) {
        const r = issueSchema.safeParse(raw);
        if (!r.success) {
          log.warn('dropping malformed issue from fetcher', r.error.issues[0]);
          continue;
        }
        if (!r.data.sampleEventUrl) {
          const ref = byId.get(r.data.id);
          if (ref) r.data.sampleEventUrl = ref;
        }
        out.push(r.data);
      }
      return out;
    },
```

In `crashfix/src/connectors/fake.ts`:

```ts
import { parseIssueRef, type Connector, type ConnectorDeps, type ConnectorFactory, type FetchParams } from './contract.js';
```

and add to the returned object after `fetchTopIssues`:

```ts
    async fetchIssuesByRef(refs: string[]): Promise<Issue[]> {
      const ids = new Set(refs.map(parseIssueRef));
      return issues.filter((i) => ids.has(i.id) || refs.some((r) => i.sampleEventUrl.includes(r)));
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd crashfix && npx vitest run test/connectors/`
Expected: PASS (new + existing connector tests).

- [ ] **Step 5: Commit**

```bash
cd crashfix && git add src/connectors test/connectors
git commit -m "feat(connectors): fetchIssuesByRef + parseIssueRef

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Wire the ledger, master doc, dedup & refs into the pipeline

**Files:**
- Modify: `crashfix/src/orchestrator/phases.ts`, `crashfix/src/orchestrator/run.ts`
- Test: `crashfix/test/orchestrator/phases.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `ledgerPathFor`, `loadLedger`, `saveLedger`, `mergeState`, `isDone` from `src/ledger.js`; `renderMaster`, `writeMaster` from `src/report.js`.
- Produces:
  - `Deps` gains `ledger: Ledger`, `ledgerPath: string`, `masterDocPath: string`.
  - `fetchPhase(d: Deps, state: RunState, refs?: string[]): Promise<void>` — new third param.
  - `RunPipelineOptions` gains `refs?: string[]`; `RunPipelineOptions['deps']` omit extended with `'ledger' | 'ledgerPath' | 'masterDocPath'`.

- [ ] **Step 1: Write the failing test**

Add to `crashfix/test/orchestrator/phases.test.ts`.

First, import at the top of the file:

```ts
import { LEDGER_VERSION, type Ledger } from '../../src/ledger.js';
```

Then give the existing `fakeDeps` helper the three new `Deps` fields by default (so every pre-existing phases test that reaches `persist` keeps working). Inside `fakeDeps`, in the `const d: any = { ... }` literal, add these lines **before** `...overrides,`:

```ts
    ledger: { version: LEDGER_VERSION, entries: {} } as Ledger,
    ledgerPath: join(root, '.crashfix', 'ledger.json'),
    masterDocPath: join(root, '.crashfix', 'master.md'),
```

A test that needs a pre-populated ledger passes `{ ledger }` through the existing `overrides` argument: `fakeDeps(root, { ledger })`.

Then the cases:

```ts
describe('fetchPhase ledger integration', () => {
  it('drops an issue whose ledger entry is terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const ledger: Ledger = { version: LEDGER_VERSION, entries: {
      i2: { id: 'i2', url: '', title: 't', type: 'crash', firstSeenAt: 'x', lastSeenAt: 'x',
        status: 'PUSHED', prUrls: {}, branch: '' },
    } };
    const d = fakeDeps(root, { ledger });
    const state = newState(d.cfg);
    await fetchPhase(d, state);
    expect(Object.keys(state.issues)).toEqual(['i1', 'i3']);
  });

  it('keeps an issue whose ledger entry is FAILED (non-terminal)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const ledger: Ledger = { version: LEDGER_VERSION, entries: {
      i2: { id: 'i2', url: '', title: 't', type: 'crash', firstSeenAt: 'x', lastSeenAt: 'x',
        status: 'FAILED', prUrls: {}, branch: '' },
    } };
    const d = fakeDeps(root, { ledger });
    const state = newState(d.cfg);
    await fetchPhase(d, state);
    expect(Object.keys(state.issues)).toContain('i2');
  });

  it('with refs, calls fetchIssuesByRef and skips the dedup filter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const ledger: Ledger = { version: LEDGER_VERSION, entries: {
      picked: { id: 'picked', url: '', title: 't', type: 'crash', firstSeenAt: 'x', lastSeenAt: 'x',
        status: 'PUSHED', prUrls: {}, branch: '' },
    } };
    const d = fakeDeps(root, {
      ledger,
      connector: {
        key: 'fake',
        fetchTopIssues: async () => { throw new Error('should not fetch top issues'); },
        fetchIssuesByRef: async (refs: string[]) => refs.map((r) => issue(r.split('/').pop()!)),
      },
    });
    const state = newState(d.cfg);
    await fetchPhase(d, state, ['https://c/issues/picked']);
    expect(Object.keys(state.issues)).toEqual(['picked']);
  });

  it('throws when refs are given but the connector has no fetchIssuesByRef', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root, {
      connector: { key: 'fake', fetchTopIssues: async () => [] },
    });
    const state = newState(d.cfg);
    await expect(fetchPhase(d, state, ['x'])).rejects.toThrow(/does not support --issue-url/);
  });

  it('persist writes the ledger file and the master doc', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root);
    const state = newState(d.cfg);
    await fetchPhase(d, state);
    expect(existsSync(join(root, '.crashfix', 'ledger.json'))).toBe(true);
    expect(existsSync(join(root, '.crashfix', 'master.md'))).toBe(true);
    expect(readFileSync(join(root, '.crashfix', 'master.md'), 'utf8')).toMatch(/master issue log/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crashfix && npx vitest run test/orchestrator/phases.test.ts`
Expected: FAIL — ledger not written; `fetchPhase` ignores `refs`; no dedup.

- [ ] **Step 3: Implement in `phases.ts`**

Adjust imports (the file already imports `{ slugify, writeReport }` from `../report.js`):

```ts
import { slugify, writeMaster, writeReport } from '../report.js';
import { isDone, mergeState, saveLedger } from '../ledger.js';
import type { Ledger } from '../ledger.js';
```

Extend `Deps`:

```ts
export interface Deps {
  // ...existing fields...
  ledger: Ledger;
  ledgerPath: string;
  masterDocPath: string;
}
```

Replace `persist`:

```ts
function persist(d: Deps, state: RunState): void {
  saveState(d.root, state);
  writeReport(d.root, state);
  mergeState(d.ledger, state);
  saveLedger(d.ledgerPath, d.ledger);
  writeMaster(d.masterDocPath, d.ledger);
}
```

Replace `fetchPhase` signature and the fetch call:

```ts
export async function fetchPhase(d: Deps, state: RunState, refs?: string[]): Promise<void> {
  let issues;
  if (refs && refs.length) {
    if (!d.connector.fetchIssuesByRef) {
      throw new Error(`issue source "${d.connector.key}" does not support --issue-url`);
    }
    issues = await d.connector.fetchIssuesByRef(refs);
  } else {
    const fetched = await d.connector.fetchTopIssues({
      limit: d.cfg.defaults.limit,
      filters: d.cfg.filters,
    });
    issues = fetched.filter((i) => !isDone(d.ledger, i.id));
  }
  const ranked = [...issues]
    .sort((a, b) => b.eventCount * b.userCount - a.eventCount * a.userCount)
    .slice(0, d.cfg.defaults.limit);
  // ...rest unchanged (state.issues = {}, waveOrder, forEach, state.phase = 'wave', persist(d, state))...
}
```


- [ ] **Step 4: Implement in `run.ts`**

Add/adjust imports (the file already imports `{ writeReport }` from `../report.js`
and `{ dirname, join }` from `node:path`):

```ts
import { writeMaster, writeReport } from '../report.js';
import { ledgerPathFor, loadLedger, mergeState, saveLedger } from '../ledger.js';
import { dirname, isAbsolute, join } from 'node:path';
```

Extend the deps omit:

```ts
export interface RunPipelineOptions {
  root: string;
  cfg: CrashfixConfig;
  deps: Omit<Deps, 'root' | 'cfg' | 'pool' | 'sem' | 'base' | 'ledger' | 'ledgerPath' | 'masterDocPath'>;
  dryRun?: boolean;
  autoApprove?: boolean;
  force?: boolean;
  refs?: string[];
}
```

`runPipeline` — pass `refs` into `core`:

```ts
  return core(o.root, cfg, base, o.deps, state, {
    dryRun: o.dryRun, autoApprove: o.autoApprove, refs: o.refs,
  });
```

`core` signature:

```ts
async function core(
  root: string,
  cfg: CrashfixConfig,
  base: string,
  raw: CoreDeps,
  state: RunState,
  opts: { dryRun?: boolean; autoApprove?: boolean; refs?: string[] },
): Promise<RunState> {
```

Build the ledger + paths and add to `d`:

```ts
  const ledgerPath = ledgerPathFor(cfg, root);
  const ledger = loadLedger(ledgerPath);
  const masterDocPath = isAbsolute(cfg.masterDocPath)
    ? cfg.masterDocPath
    : join(root, cfg.masterDocPath);
  const d: Deps = { ...raw, root, cfg, pool, sem, base, ledger, ledgerPath, masterDocPath };
```

Update the fetch call:

```ts
    if (state.phase === 'fetch') {
      await fetchPhase(d, state, opts.refs);
      state.phase = 'wave';
      saveState(root, state);
    }
```

Replace the module-local `persist` helper (used by `core`'s end-state and `dryAnalyze`):

```ts
function persist(d: Deps, state: RunState, opts: { ledger?: boolean } = {}): void {
  saveState(d.root, state);
  writeReport(d.root, state);
  if (opts.ledger !== false) {
    mergeState(d.ledger, state);
    saveLedger(d.ledgerPath, d.ledger);
    writeMaster(d.masterDocPath, d.ledger);
  }
}
```

Update every call site in `run.ts`:
- `core` dry-run branch: `persist(d, state)` → `persist(d, state, { ledger: false })`
- `core` end: `persist(root, state)` → `persist(d, state)`
- `dryAnalyze`: `persist(d.root, state)` → `persist(d, state, { ledger: false })` (both occurrences)

`resumePipeline` needs no `refs` (resume never re-fetches).

- [ ] **Step 5: Keep `test/orchestrator/run.test.ts` off the real home dir**

`run.test.ts` calls `runPipeline` ~10 times via a shared `cfg()` factory that
has no `ledgerPath`. Without a fix, `ledgerPathFor` resolves to
`~/.crashfix/ledger-default.json` — tests would read and write the developer's
real ledger (flaky: a real terminal-status entry would make `fetchPhase` drop
`i1`/`i2`/`i3`).

Change the `cfg` factory to take the test root and set a temp `ledgerPath`:

```ts
const cfg = (root: string): any => ({
  repos: [], concurrency: 2, waveSize: 2, validation: 'none', buildParallelism: 2,
  buildTimeoutSec: 60, defaults: { limit: 25 }, filters: {}, models: {}, issueSource: 'fake',
  ledgerPath: join(root, 'test-ledger.json'),
});
```

Then update every call site: `cfg()` → `cfg(root)`. Each test already has
`const { root } = makeNestedRepos();` (or `root2`) in scope before the
`runPipeline` call — use that binding. For the resume tests that reuse the same
root, pass the same `root`.

Add one assertion to the existing `'processes 3 issues across 2 waves'` test:

```ts
    expect(existsSync(join(root, 'test-ledger.json'))).toBe(true);
    expect(existsSync(join(root, '.crashfix', 'master.md'))).toBe(true);
```

Add `existsSync` to the `node:fs` import in that file.

Add one focused test:

```ts
  it('skips an issue already terminal in the ledger on a fresh run', async () => {
    const { root } = makeNestedRepos();
    const led = join(root, 'test-ledger.json');
    writeFileSync(led, JSON.stringify({
      version: 1,
      entries: { i2: { id: 'i2', url: '', title: 't', type: 'crash',
        firstSeenAt: 'x', lastSeenAt: 'x', status: 'PUSHED', prUrls: {}, branch: '' } },
    }));
    const state = await runPipeline({
      root, cfg: { ...cfg(root), ledgerPath: led }, deps: deps() as any,
    });
    expect(Object.keys(state.issues).sort()).toEqual(['i1', 'i3']);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd crashfix && npx vitest run test/orchestrator/ && npm run build`
Expected: PASS + clean type-check.

- [ ] **Step 7: Commit**

```bash
cd crashfix && git add src/orchestrator test/orchestrator
git commit -m "feat(pipeline): ledger + master doc on every persist, fetch dedup, --issue-url refs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: CLI surface — `--issue-url` and `status` from the ledger

**Files:**
- Modify: `crashfix/src/cli.ts`, `crashfix/src/cli/run.ts`, `crashfix/src/cli/status.ts`
- Test: `crashfix/test/cli/status.test.ts`

**Interfaces:**
- Consumes: `RunPipelineOptions.refs` (Task 5); `ledgerPathFor`, `loadLedger` (Task 1); `renderMaster` (Task 3); `loadConfig` (existing).
- Produces: no new exports; `crashfix run --issue-url <url>` (repeatable) and `crashfix status` reading the ledger.

- [ ] **Step 1: Write the failing test**

**Replace the whole file** `crashfix/test/cli/status.test.ts` with the content
below. The two existing tests (`'reports when no run is in progress'`,
`'prints the report summary for an existing run'`) are removed: `statusCommand`
now reads `crashfix.config.json` + the ledger, not `state.json`, and it is
acceptable that `crashfix status` requires a config file (it throws the same
`cannot read …crashfix.config.json` error `loadConfig` already throws elsewhere).

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusCommand } from '../../src/cli/status.js';

describe('statusCommand', () => {
  it('prints the master doc from the ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfx-'));
    writeFileSync(join(dir, 'crashfix.config.json'), JSON.stringify({
      firebase: { projectId: 'p', appId: 'a' },
      ledgerPath: join(dir, 'led.json'),
    }));
    writeFileSync(join(dir, 'led.json'), JSON.stringify({
      version: 1,
      entries: {
        i1: { id: 'i1', url: 'https://c/i1', title: 'NPE', type: 'crash',
          firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-02T00:00:00.000Z',
          status: 'PUSHED', prUrls: {}, branch: 'crashfix/i1' },
      },
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    statusCommand({ cwd: dir });
    expect(log.mock.calls.flat().join('\n')).toMatch(/master issue log[\s\S]*i1[\s\S]*PUSHED/);
    log.mockRestore();
  });

  it('says nothing recorded when the ledger is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfx-'));
    writeFileSync(join(dir, 'crashfix.config.json'), JSON.stringify({
      firebase: { projectId: 'nope', appId: 'nope' },
      ledgerPath: join(dir, 'absent.json'),
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    statusCommand({ cwd: dir });
    expect(log.mock.calls.flat().join(' ')).toMatch(/no issues recorded yet/);
    log.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crashfix && npx vitest run test/cli/status.test.ts`
Expected: FAIL — `statusCommand` still reads `state.json`.

- [ ] **Step 3: Implement**

`crashfix/src/cli/status.ts`:

```ts
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { ledgerPathFor, loadLedger } from '../ledger.js';
import { renderMaster } from '../report.js';

export function statusCommand(opts: { cwd: string }): void {
  const cfg = loadConfig(opts.cwd);
  const path = ledgerPathFor(cfg, opts.cwd);
  if (!existsSync(path)) {
    console.log('no issues recorded yet');
    return;
  }
  console.log(renderMaster(loadLedger(path)));
}
```

`crashfix/src/cli.ts` — in the `run` command chain, add before `.action(...)`:

```ts
  .option('--issue-url <url>', 'analyse a specific Crashlytics issue (repeatable)',
          (v: string, acc: string[]) => (acc.push(v), acc), [] as string[])
```

`crashfix/src/cli/run.ts` — `runCommand`:

```ts
  const state = await runPipeline({
    root: opts.cwd,
    cfg,
    deps: buildDeps(cfg, log),
    dryRun: opts.dryRun,
    autoApprove: opts.yes,
    force: opts.force,
    refs: opts.issueUrl,
  });
```

`opts` is typed `RunCliOptions & { cwd: string }` — `issueUrl` was added to `RunCliOptions` in Task 2.

Note: Commander passes `[]` for `--issue-url` when the flag is never used (the default). `fetchPhase` treats an empty array as "no refs", so this is fine.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd crashfix && npx vitest run test/cli/ && npm run build`
Expected: PASS + clean type-check.

- [ ] **Step 5: Commit**

```bash
cd crashfix && git add src/cli.ts src/cli/run.ts src/cli/status.ts test/cli/status.test.ts
git commit -m "feat(cli): --issue-url flag, status prints master doc from ledger

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: End-to-end coverage & docs

**Files:**
- Modify: `crashfix/test/e2e/pipeline.e2e.test.ts`, `crashfix/README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: no new exports.

- [ ] **Step 1: Pin the existing e2e test's ledger to a temp path**

The existing `it('runs 3 issues...')` builds `cfg` without `ledgerPath`, so
after Task 5 it would write to `~/.crashfix/ledger-default.json`. Add
`ledgerPath: join(root, 'e2e-ledger.json')` to that test's `cfg` object (the
`root` binding from `makeNestedRepos()` is already in scope where `cfg` is
declared — if `cfg` is declared before `root`, move the `ledgerPath` in when
calling `runPipeline` via `cfg: { ...cfg, ledgerPath: join(root, 'e2e-ledger.json') }`).

- [ ] **Step 2: Add the failing e2e assertions**

Add a new `it` block that runs its own `runPipeline` (uses the same fixture
helpers already imported), checking the ledger + master doc are produced and a
second run against the same external ledger skips a resolved issue:

```ts
  it('writes a ledger + master doc and skips resolved issues on a second run', async () => {
    const { root } = makeNestedRepos();
    seedSource(root);
    const ledgerPath = join(root, 'ext-ledger.json');
    const baseCfg: any = {
      repos: [], concurrency: 2, waveSize: 5, validation: 'none', buildParallelism: 2,
      buildTimeoutSec: 60, defaults: { limit: 25 }, filters: {}, models: {}, issueSource: 'fake',
      masterDocPath: '.crashfix/master.md', ledgerPath,
    };
    const deps = {
      git, log: nolog,
      connector: {
        key: 'fake',
        fetchTopIssues: async () => [mk('k1')],
      },
      runWorker: async (o: any) => {
        if (o.worker === 'analyzer') return { text: '# c\nx\n\nVERDICT: FIXABLE', costUsd: 0 };
        if (o.worker === 'solver' || o.worker === 'reviser') {
          const f = join(o.cwd, 'B', 'app', 'Feature.kt');
          writeFileSync(f, readFileSync(f, 'utf8').replace('feed!!', 'feed?'));
          return { text: 'fix\n\nmore', costUsd: 0 };
        }
        if (o.worker === 'publisher') {
          return { text: '```json\n{"commitMessage":"fix","prTitle":"t","prBody":"b"}\n```', costUsd: 0 };
        }
        return { text: '', costUsd: 0 };
      },
      provider: () => ({ name: 'github', openPr: async () => ({ url: 'https://gh/pr/1', id: '1' }), updatePrBody: async () => {} }),
      http: async () => ({ status: 200, json: {} }),
      launchReview: async (items: any[]) => items.map((i) => ({ issueId: i.record.issue.id, verdict: 'approve' })),
    };

    const s1 = await runPipeline({ root, cfg: baseCfg, deps });
    expect(s1.issues.k1.status).toBe('PUSHED');
    expect(existsSync(ledgerPath)).toBe(true);
    expect(existsSync(join(root, '.crashfix', 'master.md'))).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(ledger.entries.k1.status).toBe('PUSHED');

    // Second run in a fresh repo but pointed at the SAME external ledger:
    // k1 is already PUSHED there, so only k2 should be processed.
    const { root: root2 } = makeNestedRepos();
    seedSource(root2);
    const s2 = await runPipeline({
      root: root2,
      cfg: { ...baseCfg, ledgerPath },
      deps: {
        ...deps,
        connector: {
          key: 'fake',
          fetchTopIssues: async () => [mk('k1'), mk('k2')],
        },
      },
    });
    expect(Object.keys(s2.issues)).toEqual(['k2']); // k1 skipped — already PUSHED in the shared ledger
  });
```

Add `existsSync` to the file's `node:fs` import.

- [ ] **Step 3: Run the e2e test to verify it fails**

Run: `cd crashfix && npx vitest run test/e2e/pipeline.e2e.test.ts`
Expected: FAIL before Tasks 1–6 are merged; PASS once they are. If Tasks 1–6 are already done, this should pass immediately after adding the block — if it fails, debug against the spec (dedup filter in `fetchPhase`, ledger path resolution).

- [ ] **Step 4: Update the README**

In `crashfix/README.md`:

1. Under **Other commands**, change the `crashfix status` line to:
   `crashfix status` — print the **master issue log** (every issue ever processed, across all runs, with status and PR links), rendered from the ledger.

2. Add a new section after **The wave / pool model**:

```md
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
```

3. Add a new section after **Quick start**:

```md
## Fixing specific issues

To bypass the "top issues" fetch and point crashfix at issues you choose:

```bash
crashfix run --issue-url "https://console.firebase.google.com/project/…/issues/5f3a…" \
             --issue-url "https://console.firebase.google.com/project/…/issues/6a1b…"
```

`--issue-url` is repeatable and also accepts a bare issue id. Issues named this
way are always processed, even if the ledger already marks them resolved.
```

4. Add to the config reference table:

```md
| `masterDocPath` | `.crashfix/master.md` | where the master issue log is written (relative to the config dir) |
| `ledgerPath` | `~/.crashfix/ledger-<project>_<app>.json` | where the cross-run issue ledger is stored |
```

5. Under **Known limitations**, add:
   `- The ledger is never garbage-collected. After a project migration, delete the ledger file (or set a new `ledgerPath`) to start fresh.`

- [ ] **Step 5: Run the full suite**

Run: `cd crashfix && npm test && npm run build`
Expected: ALL PASS + clean type-check.

- [ ] **Step 6: Commit**

```bash
cd crashfix && git add test/e2e/pipeline.e2e.test.ts README.md
git commit -m "test(e2e): ledger persistence + cross-run dedup; docs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. Ledger — location, key, `~`, relative/absolute | 1 (`ledgerPathFor`) |
| 1. Ledger — file shape, module API | 1 |
| 1. Corrupt / version-mismatch handling, no `.bak` | 1 |
| 2. Config keys `masterDocPath`, `ledgerPath` + KNOWN_TOP_LEVEL_KEYS | 2 |
| 2. `renderMaster` / `writeMaster`, format, sort, escaping | 3 |
| 2. `persist` wiring in phases.ts + run.ts | 5 |
| 2. Dry-run must NOT touch the ledger | 5 (`persist(d, state, { ledger: false })`) |
| 3. Dedup filter on terminal statuses in `fetchPhase` | 5 |
| 3. Zero issues remaining → run completes, master doc still refreshed | 5 (fetchPhase falls through; `persist` in end-state) |
| 4. Connector contract `fetchIssuesByRef?`, `parseIssueRef` | 4 |
| 4. firebase + fake implementations | 4 |
| 4. CLI `--issue-url`, `RunCliOptions.issueUrl` | 2 (type) + 6 (flag) |
| 4. Threading `refs` run→core→fetchPhase, `RunPipelineOptions.refs` | 5 |
| 4. Error when connector lacks `fetchIssuesByRef` | 5 |
| 4. resume not plumbed with refs | 5 (noted) |
| 5. `crashfix status` reads ledger, "no issues recorded yet" | 6 |
| 6. `Deps` additions, `core` builds them, omit extended | 5 |
| Existing pipeline tests must not touch `~/.crashfix/` | 5 (run.test.ts `cfg(root)` gets a temp `ledgerPath`) + 7 (e2e cfg gets one) |
| Rollout — no state version bump, empty ledger on first run | 1 (empty ledger) + 7 (e2e) |
| Testing — every bullet | 1, 3, 4, 5, 6, 7 |

No gaps.

**Placeholder scan:** none — every code step is concrete. Task 7 Step 2 gives a
self-contained `it` block; Task 6 Step 1 hands over a complete file replacement.

**Type consistency:**
- `Ledger` / `LedgerEntry` / `LEDGER_VERSION` — defined Task 1, imported verbatim in Tasks 3, 5, 6.
- `mergeState(ledger, state)` returns `Ledger`, called for side effects in `persist` — consistent.
- `ledgerPathFor(cfg, root)` — 2 args everywhere (Tasks 1, 5, 6).
- `fetchPhase(d, state, refs?)` — 3-arg form used in Task 5 impl and Task 5 tests; `run.ts` calls `fetchPhase(d, state, opts.refs)`.
- `TERMINAL_STATUSES` values match the Global Constraints set exactly.
- `parseIssueRef` — single string arg, returns string; Tasks 4, 5.
- `renderMaster(ledger)` / `writeMaster(path, ledger)` — Tasks 3, 5, 6 consistent.
- `persist` has two distinct module-local definitions (phases.ts: `(d, state)`; run.ts: `(d, state, opts?)`) — intentional, noted in Task 5.

---

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — batch execution in this session with checkpoints.

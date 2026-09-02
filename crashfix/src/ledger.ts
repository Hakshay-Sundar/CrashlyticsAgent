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

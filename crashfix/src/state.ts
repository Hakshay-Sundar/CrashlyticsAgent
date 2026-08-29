import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CrashfixConfig } from './config.js';
import type { RunState, IssueRecord } from './types.js';

export const STATE_VERSION = 1;
export const statePath = (root: string) => join(root, '.crashfix', 'state.json');

export function newState(config: CrashfixConfig): RunState {
  return { version: STATE_VERSION, createdAt: new Date().toISOString(), config,
    issues: {}, waveOrder: [], currentWave: 0, phase: 'fetch' };
}

export function loadState(root: string): RunState | null {
  const p = statePath(root);
  if (!existsSync(p)) return null;
  let obj: RunState;
  try { obj = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`corrupt state.json (${(e as Error).message}); restore ${p}.bak`); }
  if (obj.version !== STATE_VERSION) throw new Error(`state.json version ${obj.version} != ${STATE_VERSION}`);
  return obj;
}

export function saveState(root: string, state: RunState): void {
  const p = statePath(root);
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) copyFileSync(p, p + '.bak');
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

export function upsertIssue(state: RunState, rec: IssueRecord): void {
  state.issues[rec.issue.id] = rec;
}

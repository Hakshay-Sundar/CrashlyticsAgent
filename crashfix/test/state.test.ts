import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, newState, statePath, STATE_VERSION } from '../src/state.js';

const cfg = { concurrency: 4, waveSize: 5 } as any;

describe('state store', () => {
  it('round-trips and writes a .bak on the second save', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const s = newState(cfg);
    s.issues['i1'] = { status: 'FETCHED' } as any;
    saveState(root, s);
    expect(existsSync(statePath(root) + '.bak')).toBe(false);
    s.issues['i1'].status = 'ANALYZED';
    saveState(root, s);
    expect(existsSync(statePath(root) + '.bak')).toBe(true);
    expect(loadState(root)!.issues['i1'].status).toBe('ANALYZED');
  });

  it('returns null when no state file exists', () => {
    expect(loadState(mkdtempSync(join(tmpdir(), 'cfx-')))).toBeNull();
  });

  it('throws on a future state version', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    mkdirSync(join(root, '.crashfix'), { recursive: true });
    writeFileSync(statePath(root), JSON.stringify({ version: STATE_VERSION + 1 }));
    expect(() => loadState(root)).toThrow(/version/);
  });
});

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
    expect(p).toBe(join(homedir(), '.crashfix', 'ledger-my-app-1-22-android-xyz.json'));
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

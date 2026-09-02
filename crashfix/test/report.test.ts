import { describe, it, expect } from 'vitest';
import { renderReport, renderMaster, slugify } from '../src/report.js';
import type { Ledger } from '../src/ledger.js';

const state = {
  version: 1, currentWave: 1, waveOrder: [['i1', 'i2']], phase: 'wave',
  issues: {
    i1: { issue: { id: 'i1', title: 'NPE in Feed', type: 'crash', eventCount: 900, userCount: 40 },
      status: 'PUSHED', branch: 'crashfix/npe-in-feed-i1', slot: 0, affectedRepos: ['A', 'B'],
      reportPath: 'reports/i1.md', reviewPath: 'reviews/i1.md',
      prUrls: { A: 'https://gh/pr/1', B: 'https://bb/pr/9' }, buildResult: { ok: true, tail: '' } },
    i2: { issue: { id: 'i2', title: 'ANR onCreate', type: 'anr', eventCount: 120, userCount: 5 },
      status: 'REJECTED', branch: 'crashfix/anr-oncreate-i2', slot: 1, affectedRepos: [],
      prUrls: {}, notes: 'human: not a real fix' },
  },
} as any;

describe('renderReport', () => {
  it('slugify is ascii, kebab, bounded, ends with id', () => {
    expect(slugify('NPE in  Feed!! 🎉', 'abcdef123')).toBe('npe-in-feed-abcdef123');
    expect(slugify('x'.repeat(200), 'id1').length).toBeLessThanOrEqual(48);
  });

  it('renders a row per issue with status, branch and PR links', () => {
    const md = renderReport(state);
    expect(md).toMatch(/## Summary/);
    expect(md).toContain('crashfix/npe-in-feed-i1');
    expect(md).toContain('https://gh/pr/1');
    expect(md).toContain('https://bb/pr/9');
    expect(md).toContain('PUSHED');
    expect(md).toContain('REJECTED');
    expect(md).toContain('human: not a real fix');
  });

  it('pipe characters in title/notes are escaped so the table keeps its shape', () => {
    const s = {
      version: 1, currentWave: 0, waveOrder: [['x']], phase: 'wave',
      issues: {
        x: { issue: { id: 'x', title: 'a | b', type: 'crash', eventCount: 1, userCount: 1 },
          status: 'FAILED', branch: 'crashfix/x', affectedRepos: [], prUrls: {}, notes: 'x | y' },
      },
    } as any;
    const md = renderReport(s);
    const row = md.split('\n').find((l) => l.includes('a \\| b'))!;
    expect(row).toBeTruthy();
    // 12 columns -> 13 unescaped pipes; the ones inside cells are backslash-escaped
    expect((row.match(/(?<!\\)\|/g) ?? []).length).toBe(13);
    expect(row).toContain('x \\| y');
  });

  it('summary counts by status', () => {
    const md = renderReport(state);
    expect(md).toMatch(/PUSHED: 1/);
    expect(md).toMatch(/REJECTED: 1/);
  });
});

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

import { describe, it, expect } from 'vitest';
import { renderReport, slugify } from '../src/report.js';

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

  it('summary counts by status', () => {
    const md = renderReport(state);
    expect(md).toMatch(/PUSHED: 1/);
    expect(md).toMatch(/REJECTED: 1/);
  });
});

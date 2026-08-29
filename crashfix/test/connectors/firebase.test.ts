import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { firebaseFactory } from '../../src/connectors/firebase.js';

const goodJson = JSON.stringify({ issues: [{
  id: 'ABC', title: 'NPE Feed', subtitle: 'FeedView.kt', type: 'crash',
  eventCount: 900, userCount: 40, firstSeenVersion: '4.1.0', lastSeenVersion: '4.3.0',
  stackTrace: 'java.lang.NullPointerException\n  at FeedView.render(FeedView.kt:42)',
  sampleEventUrl: 'https://console.firebase/x',
}] });

const noFilters = { minAppVersion: null, type: null, minEventCount: null, since: null } as const;

const deps = (text: string) => ({
  runWorker: async () => ({ text, costUsd: 0 }),
  mcp: { command: 'x', args: [] },
  log: { info() {}, warn() {}, error() {}, child() { return this; } },
} as any);

describe('firebaseConnector', () => {
  it('parses a fenced json block into validated issues', async () => {
    const c = firebaseFactory(deps('here you go:\n```json\n' + goodJson + '\n```\n'));
    const issues = await c.fetchTopIssues({ limit: 25, filters: { ...noFilters } });
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('ABC');
    expect(issues[0].type).toBe('crash');
  });

  it('drops malformed entries and still returns the valid ones', async () => {
    const mixed = JSON.stringify({ issues: [{ id: 'X' }, JSON.parse(goodJson).issues[0]] });
    const c = firebaseFactory(deps('```json\n' + mixed + '\n```'));
    const issues = await c.fetchTopIssues({ limit: 25, filters: { ...noFilters } });
    expect(issues.map((i) => i.id)).toEqual(['ABC']);
  });

  it('throws when no json block is present', async () => {
    const c = firebaseFactory(deps('sorry, could not reach firebase'));
    await expect(c.fetchTopIssues({ limit: 5, filters: { ...noFilters } }))
      .rejects.toThrow(/no json/i);
  });

  it('caps the result at limit and applies schema defaults', async () => {
    const sample = readFileSync(
      fileURLToPath(new URL('../fixtures/crashlytics-sample.json', import.meta.url)),
      'utf8',
    );
    const c = firebaseFactory(deps('```json\n' + sample + '\n```'));
    const issues = await c.fetchTopIssues({ limit: 2, filters: { ...noFilters } });
    expect(issues).toHaveLength(2);
    expect(issues[0].subtitle).toBe('');
    expect(issues[0].sampleEventUrl).toBe('');
  });

  it('falls back to a plain fenced block when no json tag is present', async () => {
    const c = firebaseFactory(deps('```\n' + goodJson + '\n```'));
    const issues = await c.fetchTopIssues({ limit: 25, filters: { ...noFilters } });
    expect(issues[0].id).toBe('ABC');
  });
});

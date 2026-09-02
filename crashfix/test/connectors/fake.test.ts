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

import { describe, it, expect } from 'vitest';
import { selectConnector } from '../../src/connectors/index.js';
import { fakeConnector } from '../../src/connectors/fake.js';

const issue = (id: string, over: Partial<any> = {}) => ({
  id, title: `t${id}`, subtitle: '', type: 'crash', eventCount: 100, userCount: 5,
  firstSeenVersion: '1.0.0', lastSeenVersion: '2.0.0', stackTrace: 's', sampleEventUrl: '', ...over,
});

describe('connector registry', () => {
  it('throws with available keys for an unknown source', () => {
    expect(() => selectConnector('jira', { connectors: {} } as any, {} as any))
      .toThrow(/jira.*firebase/s);
  });

  it('fake connector honors limit and type filter', async () => {
    const c = fakeConnector([issue('a'), issue('b', { type: 'anr' }), issue('c')])({} as any);
    const got = await c.fetchTopIssues({ limit: 5, filters: { minAppVersion: null, type: 'crash', minEventCount: null, since: null } });
    expect(got.map((i) => i.id)).toEqual(['a', 'c']);
  });
});

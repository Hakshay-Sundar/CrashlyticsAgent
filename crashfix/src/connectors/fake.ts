import type { Issue } from '../types.js';
import { parseIssueRef, type ConnectorFactory, type FetchParams } from './contract.js';

export function fakeConnector(issues: Issue[]): ConnectorFactory {
  return () => ({
    key: 'fake',
    async fetchTopIssues({ limit, filters }: FetchParams): Promise<Issue[]> {
      let list = issues.slice();
      if (filters.type) list = list.filter((i) => i.type === filters.type);
      if (filters.minEventCount != null) list = list.filter((i) => i.eventCount >= filters.minEventCount!);
      if (filters.minAppVersion) list = list.filter((i) => i.lastSeenVersion >= filters.minAppVersion!);
      return list.slice(0, limit);
    },
    async fetchIssuesByRef(refs: string[]): Promise<Issue[]> {
      const ids = new Set(refs.map(parseIssueRef));
      return issues.filter(
        (i) => ids.has(i.id) || refs.some((r) => r !== '' && i.sampleEventUrl.includes(r)),
      );
    },
  });
}

import type { Issue } from '../types.js';
import type { Connector, ConnectorDeps, ConnectorFactory, FetchParams } from './contract.js';

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
  });
}

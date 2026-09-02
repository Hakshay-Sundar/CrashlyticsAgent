import type { Issue } from '../types.js';
import type { Logger } from '../logger.js';
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';

export type { RunWorker } from '../workers/spawn.js';
import type { RunWorker } from '../workers/spawn.js';

export interface FetchParams {
  limit: number;
  filters: {
    minAppVersion: string | null;
    type: 'crash' | 'anr' | null;
    minEventCount: number | null;
    since: string | null;
  };
}

export interface Connector {
  key: string;
  fetchTopIssues(params: FetchParams): Promise<Issue[]>;
  fetchIssuesByRef?(refs: string[]): Promise<Issue[]>;
}

/** Extract a Crashlytics issue id from a console URL, or pass a bare id through. */
export function parseIssueRef(ref: string): string {
  const s = ref.trim();
  const m = /\/issues\/([^/?#]+)/.exec(s);
  return m ? m[1]! : s;
}

export interface ConnectorDeps {
  runWorker: RunWorker;
  mcp: McpStdioServerConfig | undefined;
  log: Logger;
  /** Firebase project/app identity from config, when the source needs it. */
  project?: { projectId: string; appId: string };
}

export type ConnectorFactory = (deps: ConnectorDeps) => Connector;

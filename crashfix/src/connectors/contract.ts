import type { Issue } from '../types.js';
import type { Logger } from '../logger.js';
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';

// TODO(task-8): import RunWorker from workers/spawn
export type RunWorker = (opts: any) => Promise<{ text: string; costUsd: number }>;

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
}

export interface ConnectorDeps {
  runWorker: RunWorker;
  mcp: McpStdioServerConfig | undefined;
  log: Logger;
}

export type ConnectorFactory = (deps: ConnectorDeps) => Connector;

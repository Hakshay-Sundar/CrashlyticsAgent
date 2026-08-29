import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { McpStdioServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import type { WorkerName } from '../config.js';

export interface WorkerOpts {
  worker: WorkerName;
  model: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpServers?: Record<string, McpStdioServerConfig>;
  maxRetries?: number; // default 1
  abort?: AbortSignal;
}

export interface WorkerResult {
  text: string;
  costUsd: number;
}

export type RunWorker = (opts: WorkerOpts) => Promise<WorkerResult>;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const RETRYABLE_SUBTYPE = new Set(['rate_limit', 'overloaded', 'server_error']);

export class WorkerError extends Error {
  constructor(worker: string, detail: string) {
    super(`worker ${worker} failed: ${detail}`);
    this.name = 'WorkerError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeRunWorker(queryImpl: typeof realQuery = realQuery): RunWorker {
  return async (opts) => {
    const maxRetries = opts.maxRetries ?? 1;
    for (let attempt = 0; ; attempt++) {
      const abortController = new AbortController();
      if (opts.abort) {
        if (opts.abort.aborted) abortController.abort();
        else opts.abort.addEventListener('abort', () => abortController.abort());
      }
      const options: Options = {
        model: opts.model,
        cwd: opts.cwd,
        systemPrompt: opts.systemPrompt,
        allowedTools: opts.allowedTools,
        mcpServers: opts.mcpServers,
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController,
      };
      let result: any;
      for await (const msg of queryImpl({ prompt: opts.prompt, options })) {
        if ((msg as any).type === 'result') result = msg;
      }

      if (result?.subtype === 'success') {
        return { text: result.result ?? '', costUsd: result.total_cost_usd ?? 0 };
      }

      const status = result?.api_error_status as number | undefined;
      const subtype = result?.error as string | undefined;
      const retryable =
        (typeof status === 'number' && RETRYABLE_STATUS.has(status)) ||
        (typeof subtype === 'string' && RETRYABLE_SUBTYPE.has(subtype));

      if (retryable && attempt < maxRetries) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      throw new WorkerError(opts.worker, `${subtype ?? 'unknown'} (${status ?? '—'})`);
    }
  };
}

export const runWorker: RunWorker = makeRunWorker();

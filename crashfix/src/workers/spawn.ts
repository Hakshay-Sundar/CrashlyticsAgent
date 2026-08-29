import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  McpStdioServerConfig,
  Options,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
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

// HTTP statuses the SDK surfaces after exhausting its own retries — worth one more attempt.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

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

    // One AbortController for the whole call; one listener, auto-removed.
    const abortController = new AbortController();
    if (opts.abort?.aborted) abortController.abort();
    else opts.abort?.addEventListener('abort', () => abortController.abort(), { once: true });

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

    for (let attempt = 0; ; attempt++) {
      let result: SDKResultMessage | undefined;
      for await (const msg of queryImpl({ prompt: opts.prompt, options })) {
        if (msg.type === 'result') result = msg;
      }

      let retryable = false;
      let detail: string;
      if (!result) {
        detail = 'no terminal result message';
      } else if (result.subtype === 'success' && result.is_error !== true) {
        return { text: result.result, costUsd: result.total_cost_usd ?? 0 };
      } else if (result.subtype === 'success') {
        // API error: SDK gave up. `result` holds the error text, not model output.
        const status = result.api_error_status ?? null;
        retryable = status == null || RETRYABLE_STATUS.has(status);
        detail = `api error ${status ?? 'connection'}: ${result.result}`;
      } else {
        // Structured terminal error (error_during_execution | error_max_turns | ...).
        retryable = result.subtype === 'error_during_execution';
        detail = `${result.subtype}: ${result.errors.join('; ')}`;
      }

      if (retryable && attempt < maxRetries) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      throw new WorkerError(opts.worker, detail);
    }
  };
}

export const runWorker: RunWorker = makeRunWorker();

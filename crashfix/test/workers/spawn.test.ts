import { describe, it, expect } from 'vitest';
import { makeRunWorker } from '../../src/workers/spawn.js';

function fakeQuery(script: any[]) {
  return () =>
    (async function* () {
      for (const m of script) yield m;
    })();
}

const base = {
  worker: 'analyzer' as const,
  model: 'opus',
  cwd: '/tmp/x',
  prompt: 'p',
  systemPrompt: 's',
  allowedTools: ['Read'],
};

describe('runWorker', () => {
  it('returns the result text and cost from the terminal message', async () => {
    const run = makeRunWorker(
      fakeQuery([
        { type: 'assistant', message: {} },
        { type: 'result', subtype: 'success', result: 'DONE', total_cost_usd: 0.02 },
      ]) as any,
    );
    expect(await run(base)).toEqual({ text: 'DONE', costUsd: 0.02 });
  });

  it('retries once on an overloaded error then succeeds', async () => {
    let calls = 0;
    const q = () => {
      calls++;
      const script =
        calls === 1
          ? [{ type: 'result', subtype: 'error', error: 'overloaded', api_error_status: 529 }]
          : [{ type: 'result', subtype: 'success', result: 'OK', total_cost_usd: 0 }];
      return (async function* () {
        for (const m of script) yield m;
      })();
    };
    const run = makeRunWorker(q as any);
    expect((await run({ ...base, maxRetries: 1 })).text).toBe('OK');
    expect(calls).toBe(2);
  });

  it('throws WorkerError naming the worker on a non-retryable error', async () => {
    const run = makeRunWorker(
      fakeQuery([
        { type: 'result', subtype: 'error', error: 'invalid_request', api_error_status: 400 },
      ]) as any,
    );
    await expect(run(base)).rejects.toThrow(/analyzer.*invalid_request/);
  });
});

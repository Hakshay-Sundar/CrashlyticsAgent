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
        { type: 'result', subtype: 'success', is_error: false, result: 'DONE', total_cost_usd: 0.02 },
      ]) as any,
    );
    expect(await run(base)).toEqual({ text: 'DONE', costUsd: 0.02 });
  });

  it('retries once on a retryable API error then succeeds', async () => {
    let calls = 0;
    const q = () => {
      calls++;
      const script =
        calls === 1
          ? [{ type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'overloaded', total_cost_usd: 0 }]
          : [{ type: 'result', subtype: 'success', is_error: false, result: 'OK', total_cost_usd: 0 }];
      return (async function* () {
        for (const m of script) yield m;
      })();
    };
    const run = makeRunWorker(q as any);
    expect((await run({ ...base, maxRetries: 1 })).text).toBe('OK');
    expect(calls).toBe(2);
  });

  it('throws WorkerError naming the worker on a non-retryable API error', async () => {
    const run = makeRunWorker(
      fakeQuery([
        { type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: 'invalid_request', total_cost_usd: 0 },
      ]) as any,
    );
    await expect(run(base)).rejects.toThrow(/analyzer.*invalid_request/);
  });

  it('throws WorkerError on a structured terminal error', async () => {
    const run = makeRunWorker(
      fakeQuery([{ type: 'result', subtype: 'error_max_turns', errors: ['ran out of turns'] }]) as any,
    );
    await expect(run(base)).rejects.toThrow(/analyzer.*error_max_turns.*ran out of turns/s);
  });

  it('throws (not returns error text as success) when a retryable API error exhausts retries', async () => {
    let calls = 0;
    const run = makeRunWorker(
      (() => {
        calls++;
        return (async function* () {
          yield { type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'overloaded', total_cost_usd: 0 };
        })();
      }) as any,
    );
    await expect(run({ ...base, maxRetries: 0 })).rejects.toThrow(/analyzer.*529.*overloaded/s);
    expect(calls).toBe(1);
  });
});

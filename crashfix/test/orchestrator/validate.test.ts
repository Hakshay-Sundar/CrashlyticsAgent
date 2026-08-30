import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/orchestrator/semaphore.js';
import { runValidation } from '../../src/orchestrator/validate.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } };

describe('runValidation', () => {
  it('mode none short-circuits', async () => {
    const r = await runValidation({ mode: 'none', repoDirs: [], lintFallback: '', timeoutSec: 1,
      sem: new Semaphore(2), deps: { exec: async () => ({ code: 0, output: '' }), log: nolog } });
    expect(r).toEqual({ mode: 'none', ok: true, tail: '', timedOut: false });
  });

  it('build fails when any repo exits non-zero and keeps the output tail', async () => {
    const exec = async (_c: string, _a: string[], o: any) =>
      o.cwd.endsWith('/B') ? { code: 1, output: 'BUILD FAILED: unresolved ref' } : { code: 0, output: 'ok' };
    const r = await runValidation({
      mode: 'build',
      repoDirs: [{ name: 'A', dir: '/w/A', buildCommand: './gradlew :a:assembleDebug' },
                 { name: 'B', dir: '/w/B', buildCommand: './gradlew :b:assembleDebug' }],
      lintFallback: './gradlew lint', timeoutSec: 5, sem: new Semaphore(2),
      deps: { exec, log: nolog },
    });
    expect(r.ok).toBe(false);
    expect(r.tail).toMatch(/unresolved ref/);
  });

  it('routes every build through the semaphore', async () => {
    const sem = new Semaphore(1);
    let peak = 0, cur = 0;
    const exec = async () => { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 15)); cur--; return { code: 0, output: '' }; };
    await runValidation({ mode: 'build',
      repoDirs: [{ name: 'A', dir: '/w/A', buildCommand: 'x' }, { name: 'B', dir: '/w/B', buildCommand: 'y' }],
      lintFallback: '', timeoutSec: 5, sem, deps: { exec, log: nolog } });
    expect(peak).toBe(1);
  });
});

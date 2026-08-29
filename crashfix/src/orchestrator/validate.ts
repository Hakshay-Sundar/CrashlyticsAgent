import type { Logger } from '../logger.js';
import type { ValidationResult } from '../types.js';
import type { Semaphore } from './semaphore.js';

export type ExecFn = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; output: string }>;

export interface ValidateDeps {
  exec: ExecFn;
  log: Logger;
}

export async function runValidation(a: {
  mode: 'build' | 'lint' | 'none';
  repoDirs: { name: string; dir: string; buildCommand?: string }[];
  lintFallback: string;
  timeoutSec: number;
  sem: Semaphore;
  deps: ValidateDeps;
}): Promise<ValidationResult> {
  if (a.mode === 'none') return { mode: 'none', ok: true, tail: '', timedOut: false };

  const parts: string[] = [];
  let ok = true, timedOut = false;

  for (const repo of a.repoDirs) {
    const raw = a.mode === 'build' ? (repo.buildCommand ?? a.lintFallback) : a.lintFallback;
    const [cmd, ...cmdArgs] = raw.trim().split(/\s+/);

    const res = await a.sem.run(async () => {
      try {
        return await a.deps.exec(cmd!, cmdArgs, { cwd: repo.dir, timeoutMs: a.timeoutSec * 1000 });
      } catch (e) {
        return { code: 124, output: `TIMEOUT/${(e as Error).message}` };
      }
    });

    if (res.code === 124) timedOut = true;
    if (res.code !== 0) ok = false;
    parts.push(`### ${repo.name}\n${res.output}`);
  }

  const joined = parts.join('\n\n');
  return { mode: a.mode, ok, timedOut, tail: joined.slice(-4000) };
}

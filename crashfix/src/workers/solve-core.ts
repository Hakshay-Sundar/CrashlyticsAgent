// Shared helpers for the solver and reviser workers: run-write worker deps,
// affected-repo detection, validation over affected repos, and the per-repo
// review-packet markdown. Task 14 (reviser) reuses all of these.
import { execa } from 'execa';
import type { Git } from '../git.js';
import type { Logger } from '../logger.js';
import type { Slot } from '../orchestrator/pool.js';
import type { Semaphore } from '../orchestrator/semaphore.js';
import { runValidation, type ExecFn } from '../orchestrator/validate.js';
import type { Issue, RepoInfo, ValidationResult } from '../types.js';
import type { RunWorker } from './spawn.js';

// Real execa-backed ExecFn. execa throws on non-zero exit and on timeout; both
// carry the captured output. Timeout surfaces as code 124 (matches validate.ts).
export const realExec: ExecFn = async (cmd, args, opts) => {
  try {
    const r = await execa(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs });
    return { code: r.exitCode ?? 0, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
  } catch (e) {
    const err = e as { timedOut?: boolean; exitCode?: number; stdout?: string; stderr?: string; shortMessage?: string; message?: string };
    if (err.timedOut) return { code: 124, output: `TIMEOUT: ${err.shortMessage ?? err.message ?? ''}` };
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() || (err.shortMessage ?? err.message ?? String(e));
    return { code: typeof err.exitCode === 'number' ? err.exitCode : 1, output };
  }
};

export interface SolveDeps {
  runWorker: RunWorker;
  model: string;
  git: Git;
  sem: Semaphore;
  log: Logger;
  validation: 'build' | 'lint' | 'none';
  buildTimeoutSec: number;
  exec?: ExecFn; // defaults to realExec; injected in tests
}

// Repos whose worktree dir has a non-empty git status.
export async function detectAffected(git: Git, slot: Slot, repos: RepoInfo[]): Promise<RepoInfo[]> {
  const hits: RepoInfo[] = [];
  for (const r of repos) {
    if ((await git.status(slot.repoDirs[r.name]!)).length) hits.push(r);
  }
  return hits;
}

export function runValidateFor(deps: SolveDeps, slot: Slot, affected: RepoInfo[]): Promise<ValidationResult> {
  return runValidation({
    mode: deps.validation,
    repoDirs: affected.map((r) => ({ name: r.name, dir: slot.repoDirs[r.name]!, buildCommand: r.buildCommand })),
    lintFallback: './gradlew lint',
    timeoutSec: deps.buildTimeoutSec,
    sem: deps.sem,
    deps: { exec: deps.exec ?? realExec, log: deps.log },
  });
}

// `## Summary` + causation link + one fenced `diff` section per affected repo,
// plus a build-failing banner when validation still isn't ok.
export async function buildReviewPacket(
  git: Git,
  slot: Slot,
  issue: Issue,
  affected: RepoInfo[],
  workerText: string,
  validation: ValidationResult,
): Promise<string> {
  const summary = (workerText.split('\n\n')[0] ?? workerText).trim();
  const sections = await Promise.all(
    affected.map(async (r) => `## Repo ${r.name}\n\n\`\`\`diff\n${await git.diff(slot.repoDirs[r.name]!)}\n\`\`\``),
  );
  const banner = validation.ok ? '' : `\n\n> ⚠ build failing\n\n\`\`\`\n${validation.tail}\n\`\`\``;
  return (
    `## Summary\n\n${summary}\n\n[Causation report](reports/${issue.id}.md)\n\n` + sections.join('\n\n') + banner
  );
}

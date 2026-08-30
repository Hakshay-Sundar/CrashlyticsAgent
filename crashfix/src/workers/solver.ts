// Solver worker: runs read-write against the slot worktree to fix the root
// cause, detects which repos changed, validates them through the semaphore,
// self-corrects once on validation failure, and renders a review packet.
import type { Slot } from '../orchestrator/pool.js';
import type { Issue, RepoInfo, ValidationResult } from '../types.js';
import { solverPrompt, solverSystemPrompt } from './prompts.js';
import { buildReviewPacket, detectAffected, runValidateFor, type SolveDeps } from './solve-core.js';

export interface SolveResult {
  affectedRepos: string[];
  validation: ValidationResult;
  reviewMarkdown: string;
  selfCorrected: boolean;
}

export async function runSolver(
  deps: SolveDeps,
  slot: Slot,
  issue: Issue,
  repos: RepoInfo[],
  causationMd: string,
): Promise<SolveResult> {
  const run = (extra = '') =>
    deps.runWorker({
      worker: 'solver',
      model: deps.model,
      cwd: slot.dir,
      systemPrompt: solverSystemPrompt(),
      prompt: solverPrompt(issue, causationMd) + extra,
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    });

  let workerText = (await run()).text;
  let affected = await detectAffected(deps.git, slot, repos);
  let validation = await runValidateFor(deps, slot, affected);
  let selfCorrected = false;

  if (!validation.ok && deps.validation !== 'none') {
    deps.log.info(`solver: ${issue.id} failed validation, self-correcting once`);
    workerText = (await run(`\n\nYour previous fix failed validation:\n\n${validation.tail}\n\nFix it.`)).text;
    affected = await detectAffected(deps.git, slot, repos);
    validation = await runValidateFor(deps, slot, affected);
    selfCorrected = true;
  }

  const reviewMarkdown = await buildReviewPacket(deps.git, slot, issue, affected, workerText, validation);
  return { affectedRepos: affected.map((r) => r.name), validation, reviewMarkdown, selfCorrected };
}

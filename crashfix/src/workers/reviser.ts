// Reviser worker: takes human review feedback on an existing fix and applies
// targeted revisions to the working tree without resetting. Reuses the affected-repo
// detection, validation, and review-packet rendering from the solver flow.
import type { Slot } from '../orchestrator/pool.js';
import type { Issue, RepoInfo } from '../types.js';
import { reviserPrompt, reviserSystemPrompt } from './prompts.js';
import { buildReviewPacket, detectAffected, runValidateFor, type SolveDeps } from './solve-core.js';
import type { SolveResult } from './solver.js';

export async function runReviser(
  deps: SolveDeps,
  slot: Slot,
  issue: Issue,
  repos: RepoInfo[],
  causationMd: string,
  humanComments: string,
): Promise<SolveResult> {
  const { text } = await deps.runWorker({
    worker: 'reviser',
    model: deps.model,
    cwd: slot.dir,
    systemPrompt: reviserSystemPrompt(),
    prompt: reviserPrompt(issue, causationMd, humanComments),
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  });

  const affectedRepos = await detectAffected(deps.git, slot, repos);
  const validation = await runValidateFor(deps, slot, affectedRepos);
  const reviewMarkdown = await buildReviewPacket(deps.git, slot, issue, affectedRepos, text, validation);

  return { affectedRepos: affectedRepos.map((r) => r.name), validation, reviewMarkdown, selfCorrected: false };
}

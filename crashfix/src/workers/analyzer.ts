// Analyzer worker: runs read-only against a worktree, produces a root-cause
// causation report and a fixable/unfixable verdict.
import type { Logger } from '../logger.js';
import type { Slot } from '../orchestrator/pool.js';
import type { Issue } from '../types.js';
import { analyzerPrompt, analyzerSystemPrompt } from './prompts.js';
import type { RunWorker } from './spawn.js';

export interface AnalyzeResult {
  unfixable: boolean;
  reason?: string;
  reportMarkdown: string;
}

// Worker is instructed to end with `VERDICT: FIXABLE` or `VERDICT: UNFIXABLE — <reason>`.
const VERDICT_RE = /^VERDICT:\s*(FIXABLE|UNFIXABLE)\s*(?:[—-]\s*(.*))?$/im;

export async function runAnalyzer(
  deps: { runWorker: RunWorker; model: string; log: Logger },
  slot: Slot,
  issue: Issue,
): Promise<AnalyzeResult> {
  const { text } = await deps.runWorker({
    worker: 'analyzer',
    model: deps.model,
    cwd: slot.dir,
    systemPrompt: analyzerSystemPrompt(),
    prompt: analyzerPrompt(issue),
    allowedTools: ['Read', 'Grep', 'Glob'],
  });

  const m = VERDICT_RE.exec(text);
  const reportMarkdown = text.replace(VERDICT_RE, '').trimEnd();

  if (m && (m[1] ?? '').toUpperCase() === 'UNFIXABLE') {
    const reason = (m[2] ?? '').trim() || 'analyzer gave no reason';
    deps.log.info(`analyzer: ${issue.id} unfixable — ${reason}`);
    return { unfixable: true, reason, reportMarkdown };
  }
  if (!m) deps.log.warn(`analyzer: ${issue.id} produced no VERDICT line — treating as fixable`);
  return { unfixable: false, reportMarkdown };
}

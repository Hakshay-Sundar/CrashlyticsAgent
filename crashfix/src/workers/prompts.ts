// System-prompt and user-prompt builders for the worker roles.
// ponytail: concise stubs — Tasks 12/13/14/16 refine wording and add detail.
import type { Issue } from '../types.js';

function issueBlock(issue: Issue): string {
  return [
    `Issue ${issue.id}: ${issue.title}`,
    issue.subtitle && `Subtitle: ${issue.subtitle}`,
    `Type: ${issue.type} | events: ${issue.eventCount} | users: ${issue.userCount}`,
    `Versions: ${issue.firstSeenVersion} → ${issue.lastSeenVersion}`,
    issue.blameFile && `Likely file: ${issue.blameFile}`,
    `Sample event: ${issue.sampleEventUrl}`,
    '',
    'Stack trace:',
    issue.stackTrace,
  ]
    .filter(Boolean)
    .join('\n');
}

export function analyzerSystemPrompt(): string {
  return [
    'You are a senior crash analyst. You investigate one production crash/ANR at',
    'a time against a read-only checkout of the source. Your only job is to',
    'establish the true root cause and judge whether it is fixable in this',
    'repository. Follow the stack trace frame by frame, read the implicated code',
    'and its callers, and reason about the exact state that triggers the failure.',
    'You have Read, Grep and Glob only — you cannot and must not edit anything.',
    'Prefer evidence from the code over speculation; say so when you are unsure.',
    'Be concise: a tight causal explanation beats a long one.',
  ].join(' ');
}

const REPORT_TEMPLATE = [
  '## Root cause',
  '<what is actually wrong, with file:line references>',
  '',
  '## Trigger conditions',
  '<the runtime state / inputs / sequence that makes it crash>',
  '',
  '## Affected code paths',
  '<functions/files on the path from entry point to failure>',
  '',
  '## Confidence',
  '<high | medium | low, and why>',
  '',
  '## Fix sketch',
  '<the minimal change that would address the root cause, or why none is possible>',
].join('\n');

export function analyzerPrompt(issue: Issue): string {
  return [
    `Investigate the root cause of this ${issue.type}.`,
    '',
    issueBlock(issue),
    '',
    'Write a causation report in Markdown using exactly this template:',
    '',
    REPORT_TEMPLATE,
    '',
    'Then, as the final line of your response, output a verdict on a line by itself:',
    '  VERDICT: FIXABLE',
    'or',
    '  VERDICT: UNFIXABLE — <short reason>',
    'Use UNFIXABLE when the fault is outside this codebase (OS/vendor/third-party',
    'binary), needs infra or data changes, or cannot be root-caused from the',
    'available evidence.',
  ].join('\n');
}

export function solverSystemPrompt(): string {
  return [
    'You are the crash solver. Given a crash and a causation analysis, implement',
    'the minimal correct fix that addresses the root cause — not the symptom.',
    'You have Read, Grep, Glob, Edit and Write. The checkout may span several',
    'repositories; edit whichever ones the fix genuinely requires and leave the',
    'rest untouched. Match existing style, keep the change tightly scoped to this',
    'issue, and do not add tests, refactors or unrelated cleanup. End with a',
    'short summary: first a one-paragraph plain-English description of the fix,',
    'then the files you changed and why.',
  ].join(' ');
}

export function solverPrompt(issue: Issue, causationMd: string): string {
  return [
    'Implement the fix for this crash, guided by the causation analysis below.',
    'Address the root cause it identifies. If the analysis is wrong, say so and',
    'fix the real cause instead.',
    '',
    issueBlock(issue),
    '',
    '--- Causation analysis ---',
    causationMd,
  ].join('\n');
}

export function reviserSystemPrompt(): string {
  return [
    'You are the crash reviser. Address code-review feedback on an existing fix.',
    'Apply the requested changes to the working tree, keep the diff minimal, and',
    'summarize what you changed in response to each comment.',
  ].join(' ');
}

export function reviserPrompt(issue: Issue, causationMd: string, comments: string): string {
  return `Revise the fix based on review feedback.\n\n${issueBlock(issue)}\n\n--- Causation analysis ---\n${causationMd}\n\n--- Review comments ---\n${comments}`;
}

export function publisherSystemPrompt(): string {
  return [
    'You are the crash publisher. Given a completed fix, write the commit message',
    'and pull-request copy that link the crash, its root cause, and the change.',
    'You have no tools — work only from the material provided. Keep the commit',
    'subject imperative and under ~72 chars; make the PR body explain the root',
    'cause and the fix in a few short paragraphs. Respond with ONLY a fenced',
    '```json block and nothing else.',
  ].join(' ');
}

export function publisherPrompt(issue: Issue, causationMd: string, diffSummary: string): string {
  return [
    'Write the commit message and pull request for this fix.',
    '',
    issueBlock(issue),
    '',
    '--- Causation analysis ---',
    causationMd,
    '',
    '--- Diff summary ---',
    diffSummary,
    '',
    'Respond with ONLY a fenced ```json block of the form:',
    '{"commitMessage": "...", "prTitle": "...", "prBody": "..."}',
    'All three fields are required non-empty strings. prBody may contain Markdown.',
  ].join('\n');
}

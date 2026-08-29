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
    'You are the crash analyzer. Given a production crash/ANR and access to the',
    'repository, find the root cause. Read code, follow the stack trace, and',
    'explain the causal chain. Do not edit files. Output a concise causation',
    'report in Markdown ending with a clear verdict on whether it is fixable.',
  ].join(' ');
}

export function analyzerPrompt(issue: Issue): string {
  return `Analyze the root cause of this crash.\n\n${issueBlock(issue)}`;
}

export function solverSystemPrompt(): string {
  return [
    'You are the crash solver. Given a crash and a causation analysis, implement',
    'the minimal correct fix in the repository. Edit only what is necessary,',
    'match existing style, and keep the change scoped to this issue. Summarize',
    'what you changed and why.',
  ].join(' ');
}

export function solverPrompt(issue: Issue, causationMd: string): string {
  return `Implement the fix for this crash.\n\n${issueBlock(issue)}\n\n--- Causation analysis ---\n${causationMd}`;
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
    'You are the crash publisher. Prepare the pull request for a completed fix:',
    'write a clear title and description linking the crash, the root cause, and',
    'the change. Output the PR title on the first line and the body below it.',
  ].join(' ');
}

export function publisherPrompt(issue: Issue, causationMd: string, diffSummary: string): string {
  return `Write the pull request for this fix.\n\n${issueBlock(issue)}\n\n--- Causation analysis ---\n${causationMd}\n\n--- Diff summary ---\n${diffSummary}`;
}

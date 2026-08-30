// Publisher: a no-tools haiku worker that drafts commit + PR copy, plus the
// deterministic multi-repo commit → push → openPr → cross-link orchestration
// with partial-failure tracking.
import type { Git } from '../git.js';
import type { Logger } from '../logger.js';
import type { Slot } from '../orchestrator/pool.js';
import type { HttpFn, Provider } from '../publish/index.js';
import { crossLinkBodies } from '../publish/index.js';
import type { Issue, RepoInfo } from '../types.js';
import type { RunWorker } from './spawn.js';
import { publisherPrompt, publisherSystemPrompt } from './prompts.js';

export interface PublishText {
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

// ponytail: local copy of firebase.ts's extractJsonBlock — sharing it is a
// refactor for later, not this task.
function extractJsonBlock(text: string): unknown {
  const m = /```json\s*([\s\S]*?)```/.exec(text) ?? /```\s*([\s\S]*?)```/.exec(text);
  if (!m) throw new Error('publisher worker returned no json block');
  try {
    return JSON.parse(m[1] ?? '');
  } catch (e) {
    throw new Error('publisher worker returned a malformed json block: ' + (e as Error).message);
  }
}

export async function runPublisherText(
  deps: { runWorker: RunWorker; model: string },
  issue: Issue,
  causationMd: string,
  diffSummary: string,
): Promise<PublishText> {
  const { text } = await deps.runWorker({
    worker: 'publisher',
    model: deps.model,
    cwd: process.cwd(),
    systemPrompt: publisherSystemPrompt(),
    prompt: publisherPrompt(issue, causationMd, diffSummary),
    allowedTools: [],
  });

  const parsed = extractJsonBlock(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('publisher json block was not an object');
  }
  const { commitMessage, prTitle, prBody } = parsed as Record<string, unknown>;
  for (const [k, v] of Object.entries({ commitMessage, prTitle, prBody })) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`publisher worker json block: field "${k}" must be a non-empty string`);
    }
  }
  return { commitMessage: commitMessage as string, prTitle: prTitle as string, prBody: prBody as string };
}

export interface PublishOutcome {
  prUrls: Record<string, string>;
  partial: boolean;
  failedRepos: string[];
}

export async function publishIssue(
  deps: {
    git: Git;
    provider: (p: RepoInfo['provider']) => Provider;
    http: HttpFn;
    log: Logger;
    base: string;
  },
  slot: Slot,
  _issue: Issue,
  repos: RepoInfo[],
  text: PublishText,
): Promise<PublishOutcome> {
  const prUrls: Record<string, string> = {};
  const failedRepos: string[] = [];
  const opened: { repo: string; url: string }[] = [];

  for (const r of repos) {
    const dir = slot.repoDirs[r.name] ?? slot.dir;
    try {
      await deps.git.add(dir, ['.']);
      await deps.git.commit(dir, text.commitMessage);
      await deps.git.push(dir, r.remote, slot.branch!);
      const remoteUrl = (await deps.git.remoteUrl(dir, r.remote)) ?? '';
      const pr = await deps.provider(r.provider).openPr(
        {
          repoDir: dir,
          remoteUrl,
          branch: slot.branch!,
          base: deps.base,
          title: text.prTitle,
          body: text.prBody,
        },
        deps.http,
      );
      prUrls[r.name] = pr.url;
      opened.push({ repo: r.name, url: pr.url });
    } catch (e) {
      deps.log.warn(`publish failed for ${r.name}`, e);
      failedRepos.push(r.name);
    }
  }

  if (opened.length > 1) {
    const linked = crossLinkBodies(opened, text.prBody);
    for (const { repo, url } of opened) {
      const provider = repos.find((x) => x.name === repo)!.provider;
      try {
        await deps.provider(provider).updatePrBody(url, linked.get(repo)!, deps.http);
      } catch (e) {
        deps.log.warn(`cross-link update failed for ${repo}`, e);
      }
    }
  }

  return {
    prUrls,
    failedRepos,
    partial: failedRepos.length > 0 && Object.keys(prUrls).length > 0,
  };
}

import type { RepoInfo } from '../types.js';
import type { HttpFn, Provider } from './provider.js';
import { githubProvider } from './github.js';
import { bitbucketProvider } from './bitbucket.js';
import { gitlabProvider } from './gitlab.js';

export type { HttpFn, OpenPrInput, Provider } from './provider.js';
export { crossLinkBodies } from './crosslink.js';

function requireToken(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} not set; export it or configure the repo to skip PR creation`);
  }
  return value;
}

export function selectProvider(provider: RepoInfo['provider'], env: NodeJS.ProcessEnv): Provider {
  switch (provider) {
    case 'github':
      return githubProvider(requireToken('GITHUB_TOKEN', env.GITHUB_TOKEN ?? env.GH_TOKEN));
    case 'bitbucket':
      return bitbucketProvider(requireToken('BITBUCKET_TOKEN', env.BITBUCKET_TOKEN));
    case 'gitlab':
      return gitlabProvider(requireToken('GITLAB_TOKEN', env.GITLAB_TOKEN));
    default:
      throw new Error(
        `no PR provider for '${provider}'; configure the repo to skip PR creation`,
      );
  }
}

/** Thin fetch wrapper — real HttpFn for production. Tests inject a fake. */
export const realHttp: HttpFn = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty / non-JSON body */
  }
  return { status: res.status, json };
};

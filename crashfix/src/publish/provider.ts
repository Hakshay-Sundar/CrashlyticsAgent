export interface OpenPrInput {
  repoDir: string;
  remoteUrl: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

export type HttpFn = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json: any }>;

export interface Provider {
  name: string;
  openPr(i: OpenPrInput, http: HttpFn): Promise<{ url: string; id: string }>;
  updatePrBody(url: string, body: string, http: HttpFn): Promise<void>;
}

/** Parse `owner/repo` (or `workspace/repo-slug`) from a git remote URL.
 *  Handles `git@host:path.git` and `https://host/path(.git)`. Keeps the full
 *  path so gitlab nested groups (`group/sub/repo`) survive. */
export function parsePath(remoteUrl: string): string {
  let s = remoteUrl.trim().replace(/\.git$/, '');
  const scp = /^[^/]+@[^:]+:(.+)$/.exec(s); // git@host:owner/repo
  if (scp) return scp[1]!.replace(/^\/+/, '');
  s = s.replace(/^ssh:\/\/[^/]+\//, '').replace(/^https?:\/\/[^/]+\//, '');
  return s.replace(/^\/+/, '');
}

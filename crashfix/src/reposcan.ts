import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RepoInfo } from './types.js';
import type { Git } from './git.js';

const SKIP = new Set(['node_modules', '.git', 'build', '.gradle', 'dist', '.idea']);

export function inferProvider(url: string): RepoInfo['provider'] {
  if (/github\.com/.test(url)) return 'github';
  if (/bitbucket\.org|bitbucket\./.test(url)) return 'bitbucket';
  if (/gitlab\.com|gitlab\./.test(url)) return 'gitlab';
  return 'unknown';
}

async function toRepoInfo(root: string, dir: string, git: Git): Promise<RepoInfo> {
  const url = (await git.remoteUrl(dir, 'origin')) ?? '';
  const rel = relative(root, dir) || '.';
  return {
    name: rel === '.' ? 'A' : rel.replace(/[\\/]/g, '-'),
    path: rel === '.' ? '.' : rel,
    remote: 'origin',
    provider: inferProvider(url),
  };
}

export async function discoverRepos(root: string, git: Git, maxDepth = 3): Promise<RepoInfo[]> {
  const out: RepoInfo[] = [await toRepoInfo(root, root, git)];
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || SKIP.has(ent.name)) continue;
      const child = join(dir, ent.name);
      if ((await git.topLevel(child)) === child) out.push(await toRepoInfo(root, child, git));
      else await walk(child, depth + 1);
    }
  }
  await walk(root, 1);
  return out;
}

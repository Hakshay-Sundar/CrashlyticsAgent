import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { realGit } from '../src/git.js';
import { inferProvider, discoverRepos } from '../src/reposcan.js';
import { makeNestedRepos } from './fixtures/repos.js';

describe('inferProvider', () => {
  it.each([
    ['git@github.com:org/app.git', 'github'],
    ['https://bitbucket.org/team/lib.git', 'bitbucket'],
    ['git@gitlab.com:grp/mod.git', 'gitlab'],
    ['https://example.com/x.git', 'unknown'],
  ])('%s -> %s', (url, want) => expect(inferProvider(url)).toBe(want));
});

describe('discoverRepos', () => {
  it('returns the root repo first, then nested repos', async () => {
    const { root } = makeNestedRepos();
    const repos = await discoverRepos(root, realGit);
    expect(repos[0].path).toBe('.');
    const names = repos.map((r) => r.path).sort();
    expect(names).toContain('B');
    expect(names).toContain('C');
  });

  it('skips .crashfix so leftover slot worktrees are not discovered as repos', async () => {
    const { root } = makeNestedRepos();
    const base = await realGit.currentBranch(root);
    // A real linked worktree: without .crashfix in SKIP, discoverRepos would see
    // its git toplevel and register it as a repo.
    const slot = join(root, '.crashfix', 'worktrees', 'slot-0');
    await realGit.worktreeAdd(root, slot, 'crashfix/pool-slot-0', base);
    const repos = await discoverRepos(root, realGit);
    expect(repos.map((r) => r.path).sort()).toEqual(['.', 'B', 'C']);
  });
});

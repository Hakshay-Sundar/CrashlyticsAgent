import { describe, it, expect } from 'vitest';
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
});

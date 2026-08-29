import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realGit as git } from '../src/git.js';
import { makeNestedRepos } from './fixtures/repos.js';

let root: string;
beforeEach(() => {
  root = makeNestedRepos().root;
});

describe('realGit', () => {
  it('finds the top level of a repo', async () => {
    expect(await git.topLevel(root)).toBe(root);
    expect(await git.topLevel('/tmp')).toBeNull();
  });

  it('checkoutNewBranch + status detects a changed file', async () => {
    const base = await git.currentBranch(root);
    await git.checkoutNewBranch(root, 'crashfix/test-x', base);
    writeFileSync(join(root, 'app.txt'), 'changed');
    const changed = await git.status(root);
    expect(changed.map((c) => c.path)).toContain('app.txt');
  });

  it('resetHard + clean returns to a pristine base', async () => {
    const base = await git.currentBranch(root);
    writeFileSync(join(root, 'junk.txt'), 'x');
    await git.checkoutNewBranch(root, 'crashfix/test-y', base);
    await git.resetHard(root, base);
    await git.clean(root, ['*.keep']);
    expect(await git.status(root)).toEqual([]);
  });

  it('worktreeAdd creates a linked worktree on a new branch, worktreeRemove deletes it', async () => {
    const base = await git.currentBranch(root);
    const wt = join(root, '.crashfix', 'worktrees', 'slot-0');
    await git.worktreeAdd(root, wt, 'crashfix/wt-test', base);
    const list = await git.worktreeList(root);
    expect(list.some((w) => w.path === wt)).toBe(true);
    await git.worktreeRemove(root, wt);
    expect((await git.worktreeList(root)).some((w) => w.path === wt)).toBe(false);
  });
});

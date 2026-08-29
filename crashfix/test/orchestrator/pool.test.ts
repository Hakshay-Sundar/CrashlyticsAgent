import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realGit as git } from '../../src/git.js';
import { createPool } from '../../src/orchestrator/pool.js';
import { discoverRepos } from '../../src/reposcan.js';
import { makeNestedRepos } from '../fixtures/repos.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } };
let root: string, repos: any[];

beforeEach(async () => { root = makeNestedRepos().root; repos = await discoverRepos(root, git); });

describe('WorktreePool', () => {
  it('creates waveSize slots, each with a worktree per repo', async () => {
    const base = await git.currentBranch(root);
    const pool = createPool({ root, repos, base, waveSize: 2, cleanExcludes: [], git, log: nolog });
    await pool.create();
    for (const n of [0, 1]) {
      expect(existsSync(join(root, '.crashfix', 'worktrees', `slot-${n}`))).toBe(true);
      expect(existsSync(join(root, '.crashfix', 'worktrees', `slot-${n}`, 'B'))).toBe(true);
    }
    await pool.destroy();
  });

  it('reset puts a slot on a fresh branch and wipes stray files', async () => {
    const base = await git.currentBranch(root);
    const pool = createPool({ root, repos, base, waveSize: 1, cleanExcludes: [], git, log: nolog });
    await pool.create();
    const slot = await pool.acquire();
    writeFileSync(join(slot.dir, 'stray.txt'), 'x');
    await pool.reset(slot, 'crashfix/issue-1');
    expect(await git.currentBranch(slot.dir)).toBe('crashfix/issue-1');
    expect(existsSync(join(slot.dir, 'stray.txt'))).toBe(false);
    await pool.destroy();
  });

  it('create() is idempotent when a slot worktree already exists', async () => {
    const base = await git.currentBranch(root);
    const pool = createPool({ root, repos, base, waveSize: 1, cleanExcludes: [], git, log: nolog });
    await pool.create();
    await expect(pool.create()).resolves.not.toThrow();
    await pool.destroy();
  });

  it('acquire blocks until a slot is released', async () => {
    const base = await git.currentBranch(root);
    const pool = createPool({ root, repos, base, waveSize: 1, cleanExcludes: [], git, log: nolog });
    await pool.create();
    const a = await pool.acquire();
    let got = false;
    const p = pool.acquire().then((s) => { got = true; return s; });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe(false);
    pool.release(a);
    await p;
    expect(got).toBe(true);
    await pool.destroy();
  });
});

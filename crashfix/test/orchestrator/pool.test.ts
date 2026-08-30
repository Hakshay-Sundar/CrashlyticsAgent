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

  it('discardSlotBranch drops the issue branch in every repo and parks the slot', async () => {
    const base = await git.currentBranch(root);
    const pool = createPool({ root, repos, base, waveSize: 1, cleanExcludes: [], git, log: nolog });
    await pool.create();
    const slot = await pool.acquire();
    await pool.reset(slot, 'crashfix/x');
    expect(await git.currentBranch(slot.dir)).toBe('crashfix/x');

    await pool.discardSlotBranch(slot, 'crashfix/x');

    expect(slot.branch).toBeUndefined();
    for (const dir of Object.values(slot.repoDirs)) {
      expect(await git.currentBranch(dir)).toBe('crashfix/pool-slot-0');
      await expect(git.revParse(dir, 'crashfix/x')).rejects.toThrow();
    }
    await pool.destroy();
  });

  it('create() is idempotent when a slot worktree already exists', async () => {
    const base = await git.currentBranch(root);
    const pool = createPool({ root, repos, base, waveSize: 1, cleanExcludes: [], git, log: nolog });
    await pool.create();
    await expect(pool.create()).resolves.not.toThrow();
    await pool.destroy();
  });

  it('slotByNumber returns the created slot, undefined otherwise', async () => {
    const base = await git.currentBranch(root);
    const pool = createPool({ root, repos, base, waveSize: 2, cleanExcludes: [], git, log: nolog });
    await pool.create();
    const s = await pool.acquire();
    expect(pool.slotByNumber(s.n)).toBe(s);
    expect(pool.slotByNumber(99)).toBeUndefined();
    await pool.destroy();
  });

  it('reserve pulls a specific slot out of the free list (or undefined)', async () => {
    const base = await git.currentBranch(root);
    const pool = createPool({ root, repos, base, waveSize: 2, cleanExcludes: [], git, log: nolog });
    await pool.create();
    const s1 = pool.reserve(1);
    expect(s1?.n).toBe(1);
    expect(pool.reserve(1)).toBeUndefined();       // already pulled
    const s0 = await pool.acquire();
    expect(s0.n).toBe(0);                            // reserve(1) didn't touch slot 0
    await pool.destroy();
  });

  it('reset rejects (does not swallow) when git fails, so the caller can bail', async () => {
    const fakeGit: any = {
      worktreeList: async () => [],
      worktreeAdd: async () => {},
      worktreeRemove: async () => {},
      checkoutNewBranch: async () => { throw new Error('checkout boom'); },
      resetHard: async () => {},
      clean: async () => {},
      deleteBranch: async () => {},
    };
    const pool = createPool({ root, repos, base: 'main', waveSize: 1, cleanExcludes: [], git: fakeGit, log: nolog });
    await pool.create();
    const slot = await pool.acquire();
    await expect(pool.reset(slot, 'crashfix/x')).rejects.toThrow('checkout boom');
  });

  it('a slot whose reset AND quarantine rebuild both fail is dropped from rotation', async () => {
    let failAdd = false;
    const fakeGit: any = {
      worktreeList: async () => [],
      worktreeAdd: async () => { if (failAdd) throw new Error('worktree add boom'); },
      worktreeRemove: async () => {},
      checkoutNewBranch: async () => { throw new Error('checkout boom'); },
      resetHard: async () => {},
      clean: async () => {},
      deleteBranch: async () => {},
    };
    const pool = createPool({ root, repos, base: 'main', waveSize: 2, cleanExcludes: [], git: fakeGit, log: nolog });
    await pool.create();
    failAdd = true;                            // quarantine's rebuild will now throw
    const bad = await pool.acquire();
    const sizeBefore = pool.size;
    await expect(pool.reset(bad, 'crashfix/x')).rejects.toThrow();
    expect(pool.size).toBe(sizeBefore - 1);
    expect(pool.slotByNumber(bad.n)).toBeUndefined();

    // acquire must never hand the dropped slot back
    const a = await pool.acquire();
    expect(a.n).not.toBe(bad.n);
    pool.release(a);
    expect(pool.reserve(bad.n)).toBeUndefined();
  });

  it('a parked acquire() rejects (not hangs) when the last slot becomes unrecoverable', async () => {
    let failAdd = false;
    const fakeGit: any = {
      worktreeList: async () => [],
      worktreeAdd: async () => { if (failAdd) throw new Error('worktree add boom'); },
      worktreeRemove: async () => {},
      checkoutNewBranch: async () => { throw new Error('checkout boom'); },
      resetHard: async () => {},
      clean: async () => {},
      deleteBranch: async () => {},
    };
    const pool = createPool({ root, repos, base: 'main', waveSize: 1, cleanExcludes: [], git: fakeGit, log: nolog });
    await pool.create();
    const only = await pool.acquire();
    const parked = pool.acquire(); // nothing can serve this yet
    failAdd = true;
    await expect(pool.reset(only, 'crashfix/x')).rejects.toThrow('checkout boom');
    await expect(parked).rejects.toThrow(/pool exhausted/);
    await expect(pool.acquire()).rejects.toThrow(/pool exhausted/); // and stays rejected
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

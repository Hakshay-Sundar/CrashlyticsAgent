import { join } from 'node:path';
import type { Git } from '../git.js';
import type { Logger } from '../logger.js';
import type { RepoInfo } from '../types.js';

export interface Slot {
  n: number;
  dir: string;
  repoDirs: Record<string, string>;
  branch?: string;
}

export interface WorktreePool {
  create(): Promise<void>;
  acquire(): Promise<Slot>;
  reset(slot: Slot, branch: string): Promise<void>;
  release(slot: Slot): void;
  // Move the slot's worktrees off `branch` (back onto the pool-slot branch) and
  // delete `branch` in every repo. Called on reject so the abandoned issue
  // branch can't survive into a later wave that re-acquires this slot.
  discardSlotBranch(slot: Slot, branch: string): Promise<void>;
  quarantine(slot: Slot): Promise<void>;
  destroy(): Promise<void>;
  // Pull the slot with number `n` OUT of the free list (or undefined if it is
  // not currently free). Used on resume to re-claim a slot that state.json
  // records as held by a live issue, so it can't also be handed out fresh.
  reserve(n: number): Slot | undefined;
  readonly size: number;
  // Look up an already-created slot by its number — used to recover the slot
  // held across review/revise/publish phases (tracked as IssueRecord.slot).
  slotByNumber(n: number): Slot | undefined;
}

export interface PoolOpts {
  root: string;
  repos: RepoInfo[];
  base: string;
  waveSize: number;
  cleanExcludes: string[];
  git: Git;
  log: Logger;
}

export function createPool(o: PoolOpts): WorktreePool {
  const slotDir = (n: number) => join(o.root, '.crashfix', 'worktrees', `slot-${n}`);
  const repoWorktreeDir = (n: number, r: RepoInfo) =>
    r.path === '.' ? slotDir(n) : join(slotDir(n), r.path);
  const repoRoot = (r: RepoInfo) => (r.path === '.' ? o.root : join(o.root, r.path));
  const slotBranch = (n: number) => `crashfix/pool-slot-${n}`;
  // Remove nested worktrees before repo A's (whose worktree IS the slot dir and
  // contains them); add back parent-first.
  const reposReversed = [...o.repos].reverse();

  let size = o.waveSize;
  const free: Slot[] = [];
  const waiters: { res: (s: Slot) => void; rej: (e: unknown) => void }[] = [];
  const all: Slot[] = [];

  function mkSlot(n: number): Slot {
    const repoDirs: Record<string, string> = {};
    for (const r of o.repos) repoDirs[r.name] = repoWorktreeDir(n, r);
    return { n, dir: slotDir(n), repoDirs };
  }

  const pool: WorktreePool = {
    get size() {
      return size;
    },

    async create() {
      for (let n = 0; n < o.waveSize; n++) {
        if (all.some((s) => s.n === n)) continue;
        const slot = mkSlot(n);
        for (const r of o.repos) {
          const wtDir = repoWorktreeDir(n, r);
          const existing = await o.git.worktreeList(repoRoot(r));
          if (!existing.some((w) => w.path === wtDir)) {
            await o.git.worktreeAdd(repoRoot(r), wtDir, slotBranch(n), o.base);
          }
        }
        all.push(slot);
        free.push(slot);
      }
    },

    slotByNumber(n) {
      return all.find((s) => s.n === n);
    },

    async acquire() {
      const s = free.pop();
      if (s) return s;
      if (all.length === 0) throw new Error('worktree pool exhausted: all slots unrecoverable');
      return new Promise<Slot>((res, rej) => waiters.push({ res, rej }));
    },

    reserve(n) {
      const i = free.findIndex((s) => s.n === n);
      return i === -1 ? undefined : free.splice(i, 1)[0];
    },

    async reset(slot, branch) {
      try {
        for (const dir of Object.values(slot.repoDirs)) {
          await o.git.checkoutNewBranch(dir, branch, o.base);
          await o.git.resetHard(dir, o.base);
          await o.git.clean(dir, o.cleanExcludes);
        }
        slot.branch = branch;
      } catch (e) {
        o.log.warn(`slot ${slot.n} reset failed, quarantining`, e);
        await pool.quarantine(slot);
        // Rethrow: the caller (runOneIssue) must record this as a setup failure
        // and stop — the worktree is not on `branch` and analysing it is garbage.
        throw e;
      }
    },

    release(slot) {
      if (!all.includes(slot)) return; // quarantined out of rotation — don't resurrect
      const w = waiters.shift();
      if (w) w.res(slot);
      else free.push(slot);
    },

    async discardSlotBranch(slot, branch) {
      for (const r of o.repos) {
        const dir = repoWorktreeDir(slot.n, r);
        try {
          await o.git.checkoutNewBranch(dir, slotBranch(slot.n), o.base);
          await o.git.deleteBranch(dir, branch);
        } catch (e) {
          o.log.warn(`discardSlotBranch: ${r.name} ${branch}`, e);
        }
      }
      slot.branch = undefined;
    },

    async quarantine(slot) {
      try {
        for (const r of reposReversed) {
          await o.git.worktreeRemove(repoRoot(r), repoWorktreeDir(slot.n, r));
        }
        for (const r of o.repos) {
          await o.git.worktreeAdd(repoRoot(r), repoWorktreeDir(slot.n, r), slotBranch(slot.n), o.base);
        }
        slot.branch = undefined;
      } catch (e) {
        size = Math.max(0, size - 1);
        // Rebuild failed — the slot has no usable worktrees. Drop it from
        // rotation entirely so acquire()/reserve() can never hand it out again.
        for (const list of [free, all]) {
          const i = list.indexOf(slot);
          if (i !== -1) list.splice(i, 1);
        }
        o.log.warn(`slot ${slot.n} unrecoverable; pool shrunk to ${size}`, e);
        // No slots left — anyone parked in acquire() would hang forever. Reject
        // them so runOneIssue surfaces it as that issue FAILED, not a deadlock.
        if (all.length === 0) {
          const err = new Error('worktree pool exhausted: all slots unrecoverable');
          while (waiters.length) waiters.shift()!.rej(err);
        }
      }
    },

    async destroy() {
      for (const slot of all) {
        for (const r of reposReversed) {
          await o.git.worktreeRemove(repoRoot(r), repoWorktreeDir(slot.n, r));
          if (slot.branch) await o.git.deleteBranch(repoRoot(r), slot.branch);
          await o.git.deleteBranch(repoRoot(r), slotBranch(slot.n));
        }
      }
    },
  };

  return pool;
}

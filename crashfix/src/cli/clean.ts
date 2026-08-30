import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { realGit } from '../git.js';
import { createLogger } from '../logger.js';
import { createPool } from '../orchestrator/pool.js';
import { loadState } from '../state.js';
import type { RepoInfo } from '../types.js';

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function cleanCommand(opts: { cwd: string; yes?: boolean }): Promise<void> {
  const { cwd } = opts;
  const dir = join(cwd, '.crashfix');
  if (!existsSync(dir)) return;

  if (!opts.yes && !(await confirm('remove .crashfix (worktrees, pool branches, state)? [y/N] '))) {
    console.log('aborted');
    return;
  }

  // Best-effort git teardown before nuking the dir: create() is idempotent and
  // needed so destroy() has slots to remove worktrees / delete pool branches.
  let state;
  try {
    state = loadState(cwd);
  } catch {
    state = null;
  }
  if (state) {
    try {
      const base = await realGit.currentBranch(cwd).catch(() => 'HEAD');
      const pool = createPool({
        root: cwd,
        repos: state.config.repos as RepoInfo[],
        base,
        waveSize: state.config.waveSize,
        cleanExcludes: state.config.cleanExcludes ?? [],
        git: realGit,
        log: createLogger(),
      });
      await pool.create();
      await pool.destroy();

      // pool.destroy() only clears the pool-slot branches; an interrupted run
      // also leaves crashfix/<slug> fix branches. Delete those too (best-effort).
      const repos = state.config.repos as RepoInfo[];
      for (const rec of Object.values(state.issues)) {
        if (!rec.branch) continue;
        for (const r of repos) {
          const repoDir = r.path === '.' ? cwd : join(cwd, r.path);
          await realGit.deleteBranch(repoDir, rec.branch).catch(() => {});
        }
      }
    } catch (e) {
      console.warn(`git worktree teardown incomplete: ${(e as Error).message}`);
    }
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${dir}`);
}

// Top-level pipeline state machine: build pool + semaphore, fetch once, then
// loop waves (solve fan-out -> review -> revise -> publish), tear down, mark
// done. Dry-run analyzes only; resume picks up from state.currentWave without
// re-fetching. A SIGINT during the run persists state before exiting 130.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CrashfixConfig } from '../config.js';
import { discoverRepos } from '../reposcan.js';
import { writeReport } from '../report.js';
import { loadState, newState, saveState } from '../state.js';
import type { RepoInfo, RunState } from '../types.js';
import { runAnalyzer } from '../workers/analyzer.js';
import type { Deps } from './phases.js';
import { fetchPhase, publishApproved, reviseAndReview, reviewWave, runOneIssue } from './phases.js';
import { createPool } from './pool.js';
import { Semaphore } from './semaphore.js';

export interface RunPipelineOptions {
  root: string;
  cfg: CrashfixConfig;
  deps: Omit<Deps, 'root' | 'cfg' | 'pool' | 'sem' | 'base'>;
  dryRun?: boolean;
  autoApprove?: boolean;
  /** Bypass the uncommitted-changes guard (`--force`). */
  force?: boolean;
}

type CoreDeps = RunPipelineOptions['deps'];

// Status past which runOneIssue must not re-run an issue on resume.
const SKIP_SOLVE = new Set([
  'IN_REVIEW', 'NEEDS_REVISION', 'APPROVED',
  'PUSHED', 'PARTIALLY_PUSHED', 'REJECTED', 'UNFIXABLE', 'FAILED',
]);

/** Async pool of N workers draining a queue — avoids a p-limit dependency. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

const repoDir = (root: string, r: RepoInfo) => (r.path === '.' ? root : join(root, r.path));

export async function runPipeline(o: RunPipelineOptions): Promise<RunState> {
  const { git } = o.deps;
  const base = await git.currentBranch(o.root);
  const repos = o.cfg.repos.length ? (o.cfg.repos as RepoInfo[]) : await discoverRepos(o.root, git);

  const dirty: string[] = [];
  for (const r of repos) {
    const changes = (await git.status(repoDir(o.root, r)))
      .filter((c) => c.path !== '.crashfix' && !c.path.startsWith('.crashfix/'));
    if (changes.length) dirty.push(r.name);
  }
  if (dirty.length && !o.force) {
    throw new Error(`uncommitted changes in: ${dirty.join(', ')} — commit/stash them or pass --force`);
  }

  const cfg = { ...o.cfg, repos: repos as CrashfixConfig['repos'] };
  const state = loadState(o.root) ?? newState(cfg);
  return core(o.root, cfg, base, o.deps, state, { dryRun: o.dryRun, autoApprove: o.autoApprove });
}

export async function resumePipeline(root: string, deps: CoreDeps): Promise<RunState> {
  const state = loadState(root);
  if (!state) throw new Error(`no .crashfix/state.json under ${root} — run \`crashfix run\` first`);
  const base = await deps.git.currentBranch(root);
  const cfgRepos = state.config.repos as RepoInfo[];
  const repos = cfgRepos.length ? cfgRepos : await discoverRepos(root, deps.git);
  const cfg = { ...state.config, repos: repos as CrashfixConfig['repos'] };
  return core(root, cfg, base, deps, state, {});
}

async function core(
  root: string,
  cfg: CrashfixConfig,
  base: string,
  raw: CoreDeps,
  state: RunState,
  opts: { dryRun?: boolean; autoApprove?: boolean },
): Promise<RunState> {
  const repos = cfg.repos as RepoInfo[];
  const pool = createPool({
    root, repos, base,
    waveSize: cfg.waveSize,
    cleanExcludes: cfg.cleanExcludes ?? [],
    git: raw.git, log: raw.log,
  });
  const sem = new Semaphore(cfg.buildParallelism);
  const d: Deps = { ...raw, root, cfg, pool, sem, base };

  saveState(root, state);

  const onSigint = () => { saveState(root, state); process.exit(130); };
  process.once('SIGINT', onSigint);

  try {
    // Only ever fetch from a pristine state — fetchPhase wipes state.issues.
    if (state.phase === 'fetch') {
      await fetchPhase(d, state);
      state.phase = 'wave';
      saveState(root, state);
    }

    if (opts.dryRun) {
      await pool.create();
      try {
        await mapLimit(Object.keys(state.issues), cfg.concurrency, (id) => dryAnalyze(d, state, id));
      } finally {
        await pool.destroy();
      }
      persist(root, state);
      return state;
    }

    // Already-complete resume: nothing to do, don't churn worktrees.
    if (state.currentWave < state.waveOrder.length) {
      await pool.create();
      try {
        for (let w = state.currentWave; w < state.waveOrder.length; w++) {
          const waveIds = state.waveOrder[w] ?? [];

          const toSolve = waveIds.filter((id) => !SKIP_SOLVE.has(state.issues[id]?.status ?? ''));
          await mapLimit(toSolve, cfg.concurrency, (id) => runOneIssue(d, state, id));

          if (opts.autoApprove) {
            for (const id of waveIds) {
              const rec = state.issues[id];
              if (rec?.status === 'IN_REVIEW') {
                rec.status = 'APPROVED';
                rec.decision = { issueId: id, verdict: 'approve' };
              }
            }
            saveState(root, state);
          } else {
            await reviewWave(d, state, waveIds);
          }

          await reviseAndReview(d, state, waveIds);

          for (const id of waveIds) {
            if (state.issues[id]?.status === 'APPROVED') await publishApproved(d, state, id);
          }

          state.currentWave = w + 1;
          saveState(root, state);
        }
      } finally {
        await pool.destroy();
      }
    }

    state.phase = 'done';
    persist(root, state);
    return state;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function persist(root: string, state: RunState): void {
  saveState(root, state);
  writeReport(root, state);
}

/** Slim dry-run path: acquire slot -> reset -> analyze -> write report -> release. */
async function dryAnalyze(d: Deps, state: RunState, id: string): Promise<void> {
  const rec = state.issues[id];
  if (!rec) return;
  const slot = await d.pool.acquire();
  try {
    await d.pool.reset(slot, rec.branch);
    const analysis = await runAnalyzer(
      { runWorker: d.runWorker, model: d.cfg.models.analyzer, log: d.log },
      slot,
      rec.issue,
    );
    const rel = `reports/${id}.md`;
    const abs = join(d.root, '.crashfix', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, analysis.reportMarkdown);
    rec.reportPath = rel;
    if (analysis.unfixable) {
      rec.status = 'UNFIXABLE';
      rec.notes = analysis.reason;
    } else {
      rec.status = 'ANALYZED';
    }
  } catch (e) {
    rec.status = 'FAILED';
    rec.failureStage = 'analyze';
    rec.notes = (e as Error).message;
  } finally {
    d.pool.release(slot);
    rec.slot = undefined;
  }
  persist(d.root, state);
}

// Top-level pipeline state machine: build pool + semaphore, fetch once, then
// loop waves (solve fan-out -> review -> revise -> publish), tear down, mark
// done. Dry-run analyzes only; resume picks up from state.currentWave without
// re-fetching. A SIGINT during the run persists state before exiting 130.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { CrashfixConfig } from '../config.js';
import { discoverRepos } from '../reposcan.js';
import { writeMaster, writeReport } from '../report.js';
import { ledgerPathFor, loadLedger, mergeState, saveLedger } from '../ledger.js';
import { loadState, newState, saveState } from '../state.js';
import type { IssueRecord, RepoInfo, RunState } from '../types.js';
import { runAnalyzer } from '../workers/analyzer.js';
import type { Deps } from './phases.js';
import { fetchPhase, publishApproved, reviseAndReview, reviewWave, runOneIssue } from './phases.js';
import { createPool, type WorktreePool } from './pool.js';
import { Semaphore } from './semaphore.js';

export interface RunPipelineOptions {
  root: string;
  cfg: CrashfixConfig;
  deps: Omit<Deps, 'root' | 'cfg' | 'pool' | 'sem' | 'base' | 'ledger' | 'ledgerPath' | 'masterDocPath'>;
  dryRun?: boolean;
  autoApprove?: boolean;
  /** Bypass the uncommitted-changes guard (`--force`). */
  force?: boolean;
  refs?: string[];
}

type CoreDeps = RunPipelineOptions['deps'];

// Status past which runOneIssue must not re-run an issue on resume.
const SKIP_SOLVE = new Set([
  'IN_REVIEW', 'NEEDS_REVISION', 'APPROVED',
  'PUSHED', 'PARTIALLY_PUSHED', 'REJECTED', 'UNFIXABLE', 'FAILED',
]);

// Statuses that legitimately pin a pool slot across review/revise/publish.
const LIVE_SLOT = new Set(['IN_REVIEW', 'NEEDS_REVISION', 'APPROVED']);

/**
 * Resume: re-claim every slot that state.json records as held by a live issue,
 * pulling it out of the pool free list so pool.acquire() can't ALSO hand it to
 * a fresh issue (which would silently put two issues in one worktree). A slot we
 * can't re-claim is treated as lost — the issue re-solves from scratch.
 */
function reclaimSlots(pool: WorktreePool, state: RunState): void {
  for (const rec of Object.values(state.issues)) {
    if (rec.slot == null) continue;
    if (LIVE_SLOT.has(rec.status)) {
      const s = pool.reserve(rec.slot);
      if (s) s.branch = rec.branch;
      else rec.slot = undefined;
    } else {
      rec.slot = undefined; // terminal / pre-solve status shouldn't pin a slot
    }
  }
}

function needsSolve(rec: IssueRecord | undefined): boolean {
  if (!rec) return false;
  if (!SKIP_SOLVE.has(rec.status)) return true;
  // Interrupted / skipped issue that lost its worktree — re-solve from scratch.
  return LIVE_SLOT.has(rec.status) && rec.slot == null;
}

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
  const loaded = loadState(o.root);
  // Explicit --issue-url must not be swallowed by a persisted state: a finished
  // state (phase 'done') skips fetchPhase entirely, so the refs would never be
  // read. Discard a completed state and start fresh; refuse if a run is mid-flight.
  let state: RunState;
  if (o.refs?.length && loaded) {
    if (loaded.phase !== 'done') {
      throw new Error('a run is already in progress (.crashfix/state.json) — finish it with `crashfix resume`, or run `crashfix clean`, before using --issue-url');
    }
    state = newState(cfg);
  } else {
    state = loaded ?? newState(cfg);
  }
  return core(o.root, cfg, base, o.deps, state, {
    dryRun: o.dryRun, autoApprove: o.autoApprove, refs: o.refs,
  });
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
  opts: { dryRun?: boolean; autoApprove?: boolean; refs?: string[] },
): Promise<RunState> {
  const repos = cfg.repos as RepoInfo[];
  const pool = createPool({
    root, repos, base,
    waveSize: cfg.waveSize,
    cleanExcludes: cfg.cleanExcludes ?? [],
    git: raw.git, log: raw.log,
  });
  const sem = new Semaphore(cfg.buildParallelism);
  const ledgerPath = ledgerPathFor(cfg, root);
  const ledger = loadLedger(ledgerPath);
  // resume from a pre-upgrade state.json has no masterDocPath
  const masterRel = cfg.masterDocPath ?? '.crashfix/master.md';
  const masterDocPath = isAbsolute(masterRel) ? masterRel : join(root, masterRel);
  const d: Deps = { ...raw, root, cfg, pool, sem, base, ledger, ledgerPath, masterDocPath };

  saveState(root, state);

  const onSigint = () => { saveState(root, state); process.exit(130); };
  process.once('SIGINT', onSigint);

  try {
    // Only ever fetch from a pristine state — fetchPhase wipes state.issues.
    if (state.phase === 'fetch') {
      await fetchPhase(d, state, opts.refs, { ledger: !opts.dryRun });
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
      persist(d, state, { ledger: false });
      return state;
    }

    // Already-complete resume: nothing to do, don't churn worktrees.
    if (state.currentWave < state.waveOrder.length) {
      await pool.create();
      reclaimSlots(pool, state);
      try {
        for (let w = state.currentWave; w < state.waveOrder.length; w++) {
          const waveIds = state.waveOrder[w] ?? [];

          const toSolve = waveIds.filter((id) => needsSolve(state.issues[id]));
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

          // Free any wave slot still pinned: a bare `skip` (or the revision cap)
          // leaves an issue IN_REVIEW holding its slot, and pool.acquire() has
          // no timeout — the next wave would hang. Just unpark the slot; LEAVE
          // the issue branch intact (the human skipped it to look at later) and
          // clear pool.branch so teardown doesn't delete it.
          for (const id of waveIds) {
            const rec = state.issues[id];
            if (rec?.slot == null) continue;
            const s = pool.slotByNumber(rec.slot);
            if (s) {
              pool.release(s);
              s.branch = undefined;
            }
            rec.slot = undefined;
          }

          // Advance the resume checkpoint only when it still points at THIS wave
          // and this wave has nothing left awaiting review — otherwise a later
          // completed wave would overwrite the checkpoint of an earlier stuck
          // one and its skipped issues would never be re-presented.
          const stuck = waveIds.some((id) => {
            const s = state.issues[id]?.status;
            return s === 'IN_REVIEW' || s === 'NEEDS_REVISION';
          });
          if (state.currentWave === w && !stuck) state.currentWave = w + 1;
          saveState(root, state);
        }
      } finally {
        await pool.destroy();
      }
    }

    state.phase = 'done';
    persist(d, state);
    return state;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function persist(d: Deps, state: RunState, opts: { ledger?: boolean } = {}): void {
  saveState(d.root, state);
  writeReport(d.root, state);
  if (opts.ledger !== false) {
    mergeState(d.ledger, state);
    saveLedger(d.ledgerPath, d.ledger);
    writeMaster(d.masterDocPath, d.ledger);
  }
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
    const rel = `reports/${rec.slug}.md`; // rec.slug is sanitized; raw id may hold `../`
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
  persist(d, state, { ledger: false });
}

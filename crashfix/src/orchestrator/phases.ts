// Per-phase functions: each wires the workers/pool/TUI together, mutates
// state.issues[id], and persists (saveState + writeReport) after every status
// change. Per-issue bodies are wrapped in try/catch → FAILED so one bad issue
// never sinks the wave.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CrashfixConfig } from '../config.js';
import type { Connector } from '../connectors/contract.js';
import type { Git } from '../git.js';
import type { Logger } from '../logger.js';
import type { HttpFn, Provider } from '../publish/index.js';
import { slugify, writeReport } from '../report.js';
import { saveState } from '../state.js';
import type { launchReview } from '../tui/review.js';
import type { ReviewItem } from '../tui/review.js';
import type { Decision, IssueRecord, RepoInfo, RunState } from '../types.js';
import { runAnalyzer } from '../workers/analyzer.js';
import { publishIssue, runPublisherText } from '../workers/publisher.js';
import { runReviser } from '../workers/reviser.js';
import type { SolveDeps } from '../workers/solve-core.js';
import { runSolver } from '../workers/solver.js';
import type { RunWorker } from '../workers/spawn.js';
import type { ExecFn } from './validate.js';
import type { Slot, WorktreePool } from './pool.js';
import type { Semaphore } from './semaphore.js';

export interface Deps {
  root: string;
  cfg: CrashfixConfig;
  git: Git;
  log: Logger;
  pool: WorktreePool;
  sem: Semaphore;
  runWorker: RunWorker;
  connector: Connector;
  provider: (p: RepoInfo['provider']) => Provider;
  http: HttpFn;
  launchReview: typeof launchReview;
  exec: ExecFn;
  base: string;
}

const MAX_REVISE_ROUNDS = 5;

function persist(d: Deps, state: RunState): void {
  saveState(d.root, state);
  writeReport(d.root, state);
}

const artifactAbs = (d: Deps, rel: string) => join(d.root, '.crashfix', rel);

function writeArtifact(d: Deps, rel: string, content: string): string {
  const abs = artifactAbs(d, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return rel;
}

function readArtifact(d: Deps, rel: string): string {
  const abs = artifactAbs(d, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

const repoList = (d: Deps): RepoInfo[] => d.cfg.repos as RepoInfo[];

function solveDeps(d: Deps, model: string): SolveDeps {
  return {
    runWorker: d.runWorker,
    model,
    git: d.git,
    sem: d.sem,
    log: d.log,
    validation: d.cfg.validation,
    buildTimeoutSec: d.cfg.buildTimeoutSec,
    exec: d.exec,
  };
}

const heldSlot = (d: Deps, rec: IssueRecord): Slot | undefined =>
  rec.slot != null ? d.pool.slotByNumber(rec.slot) : undefined;

// Release a slot and forget it on the record, so a later slotByNumber(rec.slot)
// can't hand back a slot another issue now holds.
function releaseSlot(d: Deps, rec: IssueRecord, slot: Slot): void {
  d.pool.release(slot);
  rec.slot = undefined;
}

/** connector fetch → triage (deterministic sort by blast radius) → IssueRecords + waveOrder. */
export async function fetchPhase(d: Deps, state: RunState): Promise<void> {
  const issues = await d.connector.fetchTopIssues({
    limit: d.cfg.defaults.limit,
    filters: d.cfg.filters,
  });
  const ranked = [...issues]
    .sort((a, b) => b.eventCount * b.userCount - a.eventCount * a.userCount)
    .slice(0, d.cfg.defaults.limit);

  state.issues = {};
  state.waveOrder = [];
  ranked.forEach((issue, i) => {
    const slug = slugify(issue.title, issue.id);
    const wave = Math.floor(i / d.cfg.waveSize);
    state.issues[issue.id] = {
      issue,
      status: 'FETCHED',
      slug,
      branch: `crashfix/${slug}`,
      wave,
      affectedRepos: [],
      prUrls: {},
    };
    (state.waveOrder[wave] ??= []).push(issue.id);
  });

  state.phase = 'wave';
  persist(d, state);
}

/** acquire slot → analyze → (solve) → IN_REVIEW. Slot stays HELD for revise/publish. */
export async function runOneIssue(d: Deps, state: RunState, issueId: string): Promise<void> {
  const rec = state.issues[issueId];
  if (!rec) throw new Error(`runOneIssue: unknown issue ${issueId}`);

  let slot: Slot | undefined;
  let held = false;
  let stage = 'acquire';
  try {
    slot = await d.pool.acquire();
    held = true;
    await d.pool.reset(slot, rec.branch);
    rec.slot = slot.n;

    stage = 'analyze';
    const analysis = await runAnalyzer(
      { runWorker: d.runWorker, model: d.cfg.models.analyzer, log: d.log },
      slot,
      rec.issue,
    );
    rec.reportPath = writeArtifact(d, `reports/${issueId}.md`, analysis.reportMarkdown);

    if (analysis.unfixable) {
      rec.status = 'UNFIXABLE';
      rec.notes = analysis.reason;
      held = false;
      releaseSlot(d, rec, slot);
      persist(d, state);
      return;
    }

    rec.status = 'ANALYZED';
    persist(d, state);

    stage = 'solve';
    const solve = await runSolver(
      solveDeps(d, d.cfg.models.solver),
      slot,
      rec.issue,
      repoList(d),
      analysis.reportMarkdown,
    );
    rec.reviewPath = writeArtifact(d, `reviews/${issueId}.md`, solve.reviewMarkdown);
    rec.affectedRepos = solve.affectedRepos;
    rec.buildResult = solve.validation;
    rec.status = 'IN_REVIEW';
    persist(d, state);
    // slot intentionally NOT released — revise/publish need it.
  } catch (e) {
    rec.status = 'FAILED';
    rec.failureStage = stage;
    rec.notes = (e as Error).message;
    if (held && slot) releaseSlot(d, rec, slot);
    persist(d, state);
  }
}

/** Launch the review TUI for IN_REVIEW issues in the wave and apply each decision. */
export async function reviewWave(d: Deps, state: RunState, waveIds: string[]): Promise<void> {
  const targets = waveIds
    .map((id) => state.issues[id])
    .filter((r): r is IssueRecord => !!r && r.status === 'IN_REVIEW');
  if (targets.length === 0) return;

  const items: ReviewItem[] = targets.map((rec) => ({
    record: rec,
    reviewMarkdown: readArtifact(d, rec.reviewPath ?? `reviews/${rec.issue.id}.md`),
  }));

  const decisions = await d.launchReview(items);
  const byId = new Map(decisions.map((x) => [x.issueId, x]));

  for (const rec of targets) {
    const decision = byId.get(rec.issue.id);
    if (!decision) continue;

    try {
      if (decision.verdict === 'reject') {
        rec.decision = decision;
        await rejectIssue(d, state, rec.issue.id);
        continue;
      }

      const comments = decision.comments ?? rec.decision?.comments;
      if (decision.verdict === 'approve' && !comments) {
        rec.status = 'APPROVED';
        rec.decision = decision;
        persist(d, state);
        continue;
      }
      if (comments) {
        rec.status = 'NEEDS_REVISION';
        rec.decision = { issueId: rec.issue.id, verdict: decision.verdict, comments };
        persist(d, state);
        continue;
      }
      // bare skip, no comment → leave IN_REVIEW untouched.
    } catch (e) {
      rec.status = 'FAILED';
      rec.failureStage = 'review';
      rec.notes = (e as Error).message;
      persist(d, state);
    }
  }
}

/** Loop reviser → reviewWave while anything is NEEDS_REVISION, capped at 5 rounds. */
export async function reviseAndReview(d: Deps, state: RunState, waveIds: string[]): Promise<void> {
  for (let round = 0; round < MAX_REVISE_ROUNDS; round++) {
    const pending = waveIds
      .map((id) => state.issues[id])
      .filter((r): r is IssueRecord => !!r && r.status === 'NEEDS_REVISION');
    if (pending.length === 0) return;

    for (const rec of pending) {
      const slot = heldSlot(d, rec);
      try {
        if (!slot) throw new Error('no held slot for revision');
        const causation = readArtifact(d, rec.reportPath ?? `reports/${rec.issue.id}.md`);
        const result = await runReviser(
          solveDeps(d, d.cfg.models.reviser),
          slot,
          rec.issue,
          repoList(d),
          causation,
          rec.decision?.comments ?? '',
        );
        rec.reviewPath = writeArtifact(d, `reviews/${rec.issue.id}.md`, result.reviewMarkdown);
        rec.affectedRepos = result.affectedRepos;
        rec.buildResult = result.validation;
        rec.status = 'IN_REVIEW';
        rec.decision = undefined;
        persist(d, state);
      } catch (e) {
        rec.status = 'FAILED';
        rec.failureStage = 'revise';
        rec.notes = (e as Error).message;
        if (slot) releaseSlot(d, rec, slot);
        persist(d, state);
      }
    }

    const revised = pending
      .map((r) => r.issue.id)
      .filter((id) => state.issues[id]?.status === 'IN_REVIEW');
    await reviewWave(d, state, revised);
  }

  for (const id of waveIds) {
    const rec = state.issues[id];
    if (rec?.status === 'NEEDS_REVISION') {
      rec.status = 'IN_REVIEW';
      rec.notes = `${rec.notes ? rec.notes + '; ' : ''}revision limit (${MAX_REVISE_ROUNDS} rounds) reached`;
      persist(d, state);
    }
  }
}

/** publisher copy → commit/push/openPr across affected repos → PUSHED / PARTIALLY_PUSHED. */
export async function publishApproved(d: Deps, state: RunState, issueId: string): Promise<void> {
  const rec = state.issues[issueId];
  if (!rec) throw new Error(`publishApproved: unknown issue ${issueId}`);

  const slot = heldSlot(d, rec);
  let released = false;
  try {
    if (!slot) throw new Error('no held slot for publish');
    const affected = repoList(d).filter((r) => rec.affectedRepos.includes(r.name));

    if (affected.length === 0) {
      // ponytail: solver touched no repo — nothing to commit/push/PR. Treat as
      // done rather than invoking the publisher worker on an empty changeset.
      rec.status = 'PUSHED';
      rec.notes = rec.notes ?? 'no code changes to publish';
      released = true;
      releaseSlot(d, rec, slot);
      persist(d, state);
      return;
    }

    const causation = readArtifact(d, rec.reportPath ?? `reports/${issueId}.md`);
    const diffSummary = readArtifact(d, rec.reviewPath ?? `reviews/${issueId}.md`);

    const text = await runPublisherText(
      { runWorker: d.runWorker, model: d.cfg.models.publisher },
      rec.issue,
      causation,
      diffSummary,
    );
    const outcome = await publishIssue(
      { git: d.git, provider: d.provider, http: d.http, log: d.log, base: d.base },
      slot,
      rec.issue,
      affected,
      text,
    );

    rec.prUrls = outcome.prUrls;
    const allFailed = outcome.failedRepos.length > 0 && Object.keys(outcome.prUrls).length === 0;
    if (allFailed) {
      rec.status = 'FAILED';
      rec.failureStage = 'publish';
      rec.notes = `publish failed for all repos: ${outcome.failedRepos.join(', ')}`;
    } else {
      rec.status = outcome.partial ? 'PARTIALLY_PUSHED' : 'PUSHED';
    }
    released = true;
    releaseSlot(d, rec, slot);
    persist(d, state);
  } catch (e) {
    rec.status = 'FAILED';
    rec.failureStage = 'publish';
    rec.notes = (e as Error).message;
    if (slot && !released) releaseSlot(d, rec, slot);
    persist(d, state);
  }
}

/** Human rejected the fix: drop the branch in each affected repo, release the slot. */
export async function rejectIssue(d: Deps, state: RunState, issueId: string): Promise<void> {
  const rec = state.issues[issueId];
  if (!rec) throw new Error(`rejectIssue: unknown issue ${issueId}`);

  const slot = heldSlot(d, rec);
  const repoNames = rec.affectedRepos.length ? rec.affectedRepos : repoList(d).map((r) => r.name);
  if (slot) {
    for (const name of repoNames) {
      const dir = slot.repoDirs[name];
      if (dir) await d.git.deleteBranch(dir, rec.branch);
    }
    releaseSlot(d, rec, slot);
  }

  rec.status = 'REJECTED';
  rec.notes = 'human: ' + (rec.decision?.comments ?? 'rejected');
  persist(d, state);
}

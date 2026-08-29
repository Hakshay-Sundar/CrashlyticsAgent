import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realGit as git } from '../../src/git.js';
import { runPipeline, resumePipeline } from '../../src/orchestrator/run.js';
import { createPool } from '../../src/orchestrator/pool.js';
import { discoverRepos } from '../../src/reposcan.js';
import { newState, saveState } from '../../src/state.js';
import { makeNestedRepos } from '../fixtures/repos.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } };
const issue = (id: string) => ({ id, title: `t ${id}`, subtitle: '', type: 'crash', eventCount: 9, userCount: 1, firstSeenVersion: '1', lastSeenVersion: '2', stackTrace: 's', sampleEventUrl: '' });
const cfg = (): any => ({ repos: [], concurrency: 2, waveSize: 2, validation: 'none', buildParallelism: 2, buildTimeoutSec: 60, defaults: { limit: 25 }, filters: {}, models: {}, issueSource: 'fake' });

// Fake worker: analyzer emits a verdict, publisher emits a json block, and the
// solver/reviser WRITE a real file into repo B's worktree so there is an actual
// diff to commit → push (to B's bare remote) → PR.
const runWorker = async ({ worker, cwd }: any) => {
  if (worker === 'analyzer') return { text: 'r\n\nVERDICT: FIXABLE', costUsd: 0 };
  if (worker === 'publisher') return { text: '```json\n{"commitMessage":"c","prTitle":"t","prBody":"b"}\n```', costUsd: 0 };
  writeFileSync(join(cwd, 'B', 'crashfix-fix.txt'), 'patch\n');
  return { text: 'fixed\n\nx', costUsd: 0 };
};

function deps(extra: any = {}) {
  return {
    git, log: nolog,
    connector: { key: 'fake', fetchTopIssues: async () => [issue('i1'), issue('i2'), issue('i3')] },
    runWorker,
    provider: () => ({ name: 'github', openPr: async () => ({ url: 'https://gh/pr/1', id: '1' }), updatePrBody: async () => {} }),
    http: async () => ({ status: 200, json: {} }),
    launchReview: async (items: any[]) => items.map((i: any) => ({ issueId: i.record.issue.id, verdict: 'approve' })),
    exec: async () => ({ code: 0, output: '' }),
    ...extra,
  };
}

describe('runPipeline', () => {
  it('processes 3 issues across 2 waves, pushes real PRs, reaches PUSHED', async () => {
    const { root } = makeNestedRepos();
    const state = await runPipeline({ root, cfg: cfg(), deps: deps() as any });
    expect(Object.values(state.issues).every((r: any) => r.status === 'PUSHED')).toBe(true);
    expect(Object.values(state.issues).every((r: any) => r.prUrls.B === 'https://gh/pr/1')).toBe(true);
    expect(state.waveOrder.length).toBe(2);
    expect(state.phase).toBe('done');
  });

  it('dry-run analyzes only and writes reports, no PRs', async () => {
    const { root } = makeNestedRepos();
    const state = await runPipeline({ root, cfg: cfg(), deps: deps() as any, dryRun: true });
    expect(Object.values(state.issues).every((r: any) => r.status === 'ANALYZED' || r.status === 'UNFIXABLE')).toBe(true);
    expect(Object.values(state.issues).every((r: any) => Object.keys(r.prUrls).length === 0)).toBe(true);
  });

  it('re-running runPipeline on a completed state re-analyzes nothing', async () => {
    const { root } = makeNestedRepos();
    await runPipeline({ root, cfg: cfg(), deps: deps() as any });
    let analyzeCalls = 0;
    const d2 = deps({ runWorker: async (o: any) => { if (o.worker === 'analyzer') analyzeCalls++; return runWorker(o); } });
    await runPipeline({ root, cfg: cfg(), deps: d2 as any });
    expect(analyzeCalls).toBe(0);
  });

  it('resumePipeline continues from state.currentWave without re-fetching', async () => {
    const { root } = makeNestedRepos();
    const state = newState(cfg());
    state.phase = 'wave';
    state.currentWave = 1;
    state.waveOrder = [['i1', 'i2'], ['i3']];
    for (const id of ['i1', 'i2']) {
      state.issues[id] = { issue: issue(id) as any, status: 'PUSHED', slug: id, branch: `crashfix/${id}`, wave: 0, affectedRepos: ['B'], prUrls: { B: 'https://gh/pr/old' } };
    }
    state.issues['i3'] = { issue: issue('i3') as any, status: 'FETCHED', slug: 'i3', branch: 'crashfix/i3', wave: 1, affectedRepos: [], prUrls: {} };
    saveState(root, state);

    let fetched = 0;
    const d = deps({ connector: { key: 'fake', fetchTopIssues: async () => { fetched++; return [issue('i1'), issue('i2'), issue('i3')]; } } });
    const out = await resumePipeline(root, d as any);

    expect(fetched).toBe(0);
    expect(out.issues['i1'].status).toBe('PUSHED');
    expect(out.issues['i1'].prUrls.B).toBe('https://gh/pr/old');
    expect(out.issues['i2'].status).toBe('PUSHED');
    expect(out.issues['i3'].status).toBe('PUSHED');
    expect(out.issues['i3'].prUrls.B).toBe('https://gh/pr/1');
    expect(out.phase).toBe('done');
  });

  it('B1: skip-all does not deadlock — issues stay IN_REVIEW, hold no slot, phase advances', async () => {
    const { root } = makeNestedRepos();
    const d = deps({
      connector: { key: 'fake', fetchTopIssues: async () => [issue('i1'), issue('i2')] },
      launchReview: async (items: any[]) => items.map((i: any) => ({ issueId: i.record.issue.id, verdict: 'skip' })),
    });
    const state = await runPipeline({ root, cfg: cfg(), deps: d as any });
    expect(state.issues['i1'].status).toBe('IN_REVIEW');
    expect(state.issues['i2'].status).toBe('IN_REVIEW');
    expect(state.issues['i1'].slot).toBeUndefined();
    expect(state.issues['i2'].slot).toBeUndefined();
    expect(state.phase).toBe('done');
    expect(state.currentWave).toBe(0); // stuck wave is not checkpointed past
  });

  it('B1: a resume run re-presents the skipped issues; approving them pushes', async () => {
    const { root } = makeNestedRepos();
    const skip = deps({
      connector: { key: 'fake', fetchTopIssues: async () => [issue('i1'), issue('i2')] },
      launchReview: async (items: any[]) => items.map((i: any) => ({ issueId: i.record.issue.id, verdict: 'skip' })),
    });
    await runPipeline({ root, cfg: cfg(), deps: skip as any });

    const out = await resumePipeline(root, deps({
      connector: { key: 'fake', fetchTopIssues: async () => { throw new Error('must not fetch on resume'); } },
    }) as any);
    expect(out.issues['i1'].status).toBe('PUSHED');
    expect(out.issues['i2'].status).toBe('PUSHED');
    expect(out.issues['i1'].prUrls.B).toBe('https://gh/pr/1');
    expect(out.phase).toBe('done');
  });

  it('B2: resume never hands a persisted held slot to a fresh issue', async () => {
    const { root } = makeNestedRepos();
    const base = await git.currentBranch(root);
    const repos = await discoverRepos(root, git);

    // Stand up the pool worktrees as an interrupted run would leave them, with
    // slot 1 checked out on i1's branch and carrying i1's fix.
    const pool = createPool({ root, repos, base, waveSize: 2, cleanExcludes: [], git, log: nolog });
    await pool.create();
    const s1 = pool.reserve(1)!;
    await pool.reset(s1, 'crashfix/i1');
    writeFileSync(join(s1.repoDirs.B, 'i1-fix.txt'), 'i1 patch\n');

    const state = newState({ ...cfg(), repos } as any);
    state.phase = 'wave';
    state.currentWave = 0;
    state.waveOrder = [['i1', 'i2']];
    state.issues['i1'] = { issue: issue('i1') as any, status: 'IN_REVIEW', slug: 'i1', branch: 'crashfix/i1', wave: 0, slot: 1, affectedRepos: ['B'], reviewPath: 'reviews/i1.md', prUrls: {} };
    state.issues['i2'] = { issue: issue('i2') as any, status: 'FETCHED', slug: 'i2', branch: 'crashfix/i2', wave: 0, affectedRepos: [], prUrls: {} };
    saveState(root, state);
    mkdirSync(join(root, '.crashfix/reviews'), { recursive: true });
    writeFileSync(join(root, '.crashfix/reviews/i1.md'), '## Summary\ni1');

    const out = await resumePipeline(root, deps({
      connector: { key: 'fake', fetchTopIssues: async () => { throw new Error('must not fetch'); } },
      provider: () => ({ name: 'github', openPr: async (o: any) => ({ url: `https://gh/${o.branch}`, id: '1' }), updatePrBody: async () => {} }),
    }) as any);

    expect(out.issues['i1'].status).toBe('PUSHED');
    expect(out.issues['i2'].status).toBe('PUSHED');
    // i1 kept its own worktree/branch; i2 got a different one and did not clobber it.
    expect(out.issues['i1'].prUrls.B).toBe('https://gh/crashfix/i1');
    expect(out.issues['i2'].prUrls.B).toBe('https://gh/crashfix/i2');
  });
});

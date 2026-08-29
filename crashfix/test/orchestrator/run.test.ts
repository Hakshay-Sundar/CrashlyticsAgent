import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realGit as git } from '../../src/git.js';
import { runPipeline, resumePipeline } from '../../src/orchestrator/run.js';
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
});

import { describe, it, expect } from 'vitest';
import { realGit as git } from '../../src/git.js';
import { runPipeline } from '../../src/orchestrator/run.js';
import { makeNestedRepos } from '../fixtures/repos.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } };
const issue = (id: string) => ({ id, title: `t ${id}`, subtitle: '', type: 'crash', eventCount: 9, userCount: 1, firstSeenVersion: '1', lastSeenVersion: '2', stackTrace: 's', sampleEventUrl: '' });

function deps(extra: any = {}) {
  return {
    git, log: nolog,
    connector: { key: 'fake', fetchTopIssues: async () => [issue('i1'), issue('i2'), issue('i3')] },
    runWorker: async ({ worker }: any) => ({ text: worker === 'analyzer' ? 'r\n\nVERDICT: FIXABLE' : 'fixed\n\nx', costUsd: 0 }),
    provider: () => ({ name: 'github', openPr: async () => ({ url: 'https://gh/pr/1', id: '1' }), updatePrBody: async () => {} }),
    http: async () => ({ status: 200, json: {} }),
    launchReview: async (items: any[]) => items.map((i: any) => ({ issueId: i.record.issue.id, verdict: 'approve' })),
    exec: async () => ({ code: 0, output: '' }),
    ...extra,
  };
}

describe('runPipeline', () => {
  it('processes 3 issues across 2 waves and reaches PUSHED', async () => {
    const { root } = makeNestedRepos();
    const cfg: any = { repos: [], concurrency: 2, waveSize: 2, validation: 'none', buildParallelism: 2, buildTimeoutSec: 60, defaults: { limit: 25 }, filters: {}, models: {}, issueSource: 'fake' };
    const state = await runPipeline({ root, cfg, deps: deps() as any });
    expect(Object.values(state.issues).every((r: any) => r.status === 'PUSHED')).toBe(true);
    expect(state.waveOrder.length).toBe(2);
    expect(state.phase).toBe('done');
  });

  it('dry-run analyzes only and writes reports, no PRs', async () => {
    const { root } = makeNestedRepos();
    const cfg: any = { repos: [], concurrency: 2, waveSize: 2, validation: 'none', buildParallelism: 2, buildTimeoutSec: 60, defaults: { limit: 25 }, filters: {}, models: {}, issueSource: 'fake' };
    const state = await runPipeline({ root, cfg, deps: deps() as any, dryRun: true });
    expect(Object.values(state.issues).every((r: any) => r.status === 'ANALYZED' || r.status === 'UNFIXABLE')).toBe(true);
  });

  it('resume skips already-PUSHED issues', async () => {
    const { root } = makeNestedRepos();
    const cfg: any = { repos: [], concurrency: 2, waveSize: 2, validation: 'none', buildParallelism: 2, buildTimeoutSec: 60, defaults: { limit: 25 }, filters: {}, models: {}, issueSource: 'fake' };
    await runPipeline({ root, cfg, deps: deps() as any });
    let analyzeCalls = 0;
    const d2 = deps({ runWorker: async ({ worker }: any) => { if (worker === 'analyzer') analyzeCalls++; return { text: 'r\n\nVERDICT: FIXABLE', costUsd: 0 }; } });
    await runPipeline({ root, cfg, deps: d2 as any });   // loads existing state
    expect(analyzeCalls).toBe(0);
  });
});

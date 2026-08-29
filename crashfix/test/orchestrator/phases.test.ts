import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPhase, runOneIssue, reviewWave } from '../../src/orchestrator/phases.js';
import { newState } from '../../src/state.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } };

const issue = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `t ${id}`, subtitle: '', type: 'crash', eventCount: 9, userCount: 1,
  firstSeenVersion: '1', lastSeenVersion: '2', stackTrace: 's', sampleEventUrl: '', ...over,
});

function fakeDeps(root: string, overrides: Record<string, unknown> = {}) {
  const slot = {
    n: 0,
    dir: join(root, '.crashfix/worktrees/slot-0'),
    repoDirs: { A: join(root, '.crashfix/worktrees/slot-0') },
    branch: undefined as string | undefined,
  };
  return {
    root, base: 'main', log: nolog, exec: async () => ({ code: 0, output: '' }),
    cfg: {
      waveSize: 2, validation: 'none', buildTimeoutSec: 60,
      models: { analyzer: 'opus', solver: 'sonnet', reviser: 'sonnet', publisher: 'haiku', reporter: 'haiku' },
      defaults: { limit: 25 },
      filters: { minAppVersion: null, type: null, minEventCount: null, since: null },
      repos: [{ name: 'A', path: '.', remote: 'origin', provider: 'github' }],
    },
    git: {
      status: async () => [{ path: 'A.kt' }], diff: async () => 'D',
      deleteBranch: async () => {}, add: async () => {}, commit: async () => 's',
      push: async () => {}, remoteUrl: async () => 'git@github.com:o/r.git',
    },
    pool: {
      acquire: async () => slot,
      reset: async (s: any, b: string) => { s.branch = b; },
      release() {},
      slotByNumber: () => slot,
    },
    sem: { run: (f: any) => f() },
    connector: { key: 'fake', fetchTopIssues: async () => [issue('i1'), issue('i2'), issue('i3')] },
    runWorker: async ({ worker }: any) => ({
      text: worker === 'analyzer' ? '# report\nroot cause\n\nVERDICT: FIXABLE' : 'fixed it\n\nmore',
      costUsd: 0,
    }),
    provider: () => ({ name: 'github', openPr: async () => ({ url: 'u', id: '1' }), updatePrBody: async () => {} }),
    http: async () => ({ status: 200, json: {} }),
    launchReview: async (items: any[]) => items.map((i) => ({ issueId: i.record.issue.id, verdict: 'approve' })),
    ...overrides,
  } as any;
}

const seedIssue = (state: any, id: string, over: Record<string, unknown> = {}) => {
  state.issues[id] = {
    issue: issue(id), status: 'FETCHED', slug: 'x', branch: 'crashfix/x',
    wave: 0, affectedRepos: [], prUrls: {}, ...over,
  };
};

describe('phases', () => {
  it('fetchPhase caps at limit and chunks into waves of waveSize', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root);
    const state = newState(d.cfg);
    await fetchPhase(d, state);
    expect(Object.keys(state.issues)).toEqual(['i1', 'i2', 'i3']);
    expect(state.waveOrder.flat().length).toBe(3);
    expect(state.waveOrder[0].length).toBe(2);
    expect(state.waveOrder[1].length).toBe(1);
    expect(state.issues['i1'].branch).toBe(`crashfix/${state.issues['i1'].slug}`);
    expect(state.issues['i3'].wave).toBe(1);
    expect(state.phase).toBe('wave');
    expect(existsSync(join(root, '.crashfix/state.json'))).toBe(true);
  });

  it('runOneIssue takes an issue to IN_REVIEW with a review packet on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root);
    const state = newState(d.cfg);
    seedIssue(state, 'i1');
    await runOneIssue(d, state, 'i1');
    expect(state.issues['i1'].status).toBe('IN_REVIEW');
    expect(state.issues['i1'].affectedRepos).toEqual(['A']);
    expect(state.issues['i1'].reviewPath).toBeTruthy();
    expect(state.issues['i1'].reportPath).toBeTruthy();
    expect(state.issues['i1'].slot).toBe(0);
    expect(readFileSync(join(root, '.crashfix', state.issues['i1'].reviewPath), 'utf8')).toContain('fixed it');
    expect(readFileSync(join(root, '.crashfix', state.issues['i1'].reportPath), 'utf8')).not.toContain('VERDICT');
  });

  it('runOneIssue marks UNFIXABLE and never solves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root, { runWorker: async () => ({ text: '# r\n\nVERDICT: UNFIXABLE — vendor .so', costUsd: 0 }) });
    const state = newState(d.cfg);
    seedIssue(state, 'i1');
    await runOneIssue(d, state, 'i1');
    expect(state.issues['i1'].status).toBe('UNFIXABLE');
    expect(state.issues['i1'].notes).toMatch(/vendor \.so/);
    expect(state.issues['i1'].reviewPath).toBeFalsy();
  });

  it('runOneIssue -> FAILED with failureStage on worker throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root, { runWorker: async () => { throw new Error('sdk boom'); } });
    const state = newState(d.cfg);
    seedIssue(state, 'i1');
    await runOneIssue(d, state, 'i1');
    expect(state.issues['i1'].status).toBe('FAILED');
    expect(state.issues['i1'].failureStage).toBe('analyze');
    expect(state.issues['i1'].notes).toMatch(/sdk boom/);
  });

  it('reviewWave: plain approve -> APPROVED', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root);
    const state = newState(d.cfg);
    seedIssue(state, 'i1', { status: 'IN_REVIEW', slot: 0, affectedRepos: ['A'], reviewPath: 'reviews/i1.md' });
    mkdirSync(join(root, '.crashfix/reviews'), { recursive: true });
    writeFileSync(join(root, '.crashfix/reviews/i1.md'), '## Summary\nx');
    await reviewWave(d, state, ['i1']);
    expect(state.issues['i1'].status).toBe('APPROVED');
  });

  it('reviewWave: approve with comments -> NEEDS_REVISION', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root, { launchReview: async () => [{ issueId: 'i1', verdict: 'approve', comments: 'tweak' }] });
    const state = newState(d.cfg);
    seedIssue(state, 'i1', { status: 'IN_REVIEW', slot: 0, affectedRepos: ['A'], reviewPath: 'reviews/i1.md' });
    mkdirSync(join(root, '.crashfix/reviews'), { recursive: true });
    writeFileSync(join(root, '.crashfix/reviews/i1.md'), '## Summary\nx');
    await reviewWave(d, state, ['i1']);
    expect(state.issues['i1'].status).toBe('NEEDS_REVISION');
    expect(state.issues['i1'].decision?.comments).toBe('tweak');
  });

  it('reviewWave: reject -> REJECTED, branch deleted, slot released', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const deleted: string[] = [];
    let released = 0;
    const d = fakeDeps(root, {
      launchReview: async () => [{ issueId: 'i1', verdict: 'reject', comments: 'nope' }],
      git: { ...fakeDeps(root).git, deleteBranch: async (_d: string, b: string) => { deleted.push(b); } },
    });
    d.pool.release = () => { released++; };
    const state = newState(d.cfg);
    seedIssue(state, 'i1', { status: 'IN_REVIEW', slot: 0, affectedRepos: ['A'], reviewPath: 'reviews/i1.md' });
    mkdirSync(join(root, '.crashfix/reviews'), { recursive: true });
    writeFileSync(join(root, '.crashfix/reviews/i1.md'), '## Summary\nx');
    await reviewWave(d, state, ['i1']);
    expect(state.issues['i1'].status).toBe('REJECTED');
    expect(state.issues['i1'].notes).toBe('human: nope');
    expect(deleted).toEqual(['crashfix/x']);
    expect(released).toBe(1);
  });
});

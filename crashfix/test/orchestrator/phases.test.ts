import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPhase, runOneIssue, reviewWave, reviseAndReview, publishApproved } from '../../src/orchestrator/phases.js';
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
  const d: any = {
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
      discardSlotBranch: async (_s: any, b: string) => {
        for (const dir of Object.values(slot.repoDirs)) await d.git.deleteBranch(dir, b);
      },
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
  };
  return d;
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

  it('runOneIssue -> FAILED releases the slot and clears rec.slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    let released = 0;
    const d = fakeDeps(root, { runWorker: async () => { throw new Error('sdk boom'); } });
    d.pool.release = () => { released++; };
    const state = newState(d.cfg);
    seedIssue(state, 'i1');
    await runOneIssue(d, state, 'i1');
    expect(state.issues['i1'].status).toBe('FAILED');
    expect(state.issues['i1'].failureStage).toBe('analyze');
    expect(state.issues['i1'].notes).toMatch(/sdk boom/);
    expect(released).toBe(1);
    expect(state.issues['i1'].slot).toBeUndefined();
  });

  it('runOneIssue -> FAILED when the solver produces no changes (never reaches IN_REVIEW)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    let released = 0;
    const d = fakeDeps(root, {
      git: { ...fakeDeps(root).git, status: async () => [] }, // no worktree changes
    });
    d.pool.release = () => { released++; };
    const state = newState(d.cfg);
    seedIssue(state, 'i1');
    await runOneIssue(d, state, 'i1');
    expect(state.issues['i1'].status).toBe('FAILED');
    expect(state.issues['i1'].failureStage).toBe('solve');
    expect(state.issues['i1'].notes).toBe('solver produced no changes');
    expect(released).toBe(1);
    expect(state.issues['i1'].slot).toBeUndefined();
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

  const seedReview = (root: string) => {
    mkdirSync(join(root, '.crashfix/reviews'), { recursive: true });
    mkdirSync(join(root, '.crashfix/reports'), { recursive: true });
    writeFileSync(join(root, '.crashfix/reviews/i1.md'), '## Summary\nx');
    writeFileSync(join(root, '.crashfix/reports/i1.md'), '# causation');
  };

  it('reviseAndReview: stops at the 5-round cap, leaves IN_REVIEW + note', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    let reviserCalls = 0;
    const d = fakeDeps(root, {
      runWorker: async ({ worker }: any) => {
        if (worker === 'reviser') reviserCalls++;
        return { text: 'revised\n\nx', costUsd: 0 };
      },
      launchReview: async () => [{ issueId: 'i1', verdict: 'approve', comments: 'more' }],
    });
    seedReview(root);
    const state = newState(d.cfg);
    seedIssue(state, 'i1', {
      status: 'NEEDS_REVISION', slot: 0, affectedRepos: ['A'],
      reviewPath: 'reviews/i1.md', reportPath: 'reports/i1.md',
      decision: { issueId: 'i1', verdict: 'approve', comments: 'more' },
    });
    await reviseAndReview(d, state, ['i1']);
    expect(reviserCalls).toBe(5);
    expect(state.issues['i1'].status).toBe('IN_REVIEW');
    expect(state.issues['i1'].notes).toMatch(/revision limit/);
  });

  it('reviseAndReview: one round then bare approve -> APPROVED', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    let reviserCalls = 0;
    const d = fakeDeps(root, {
      runWorker: async ({ worker }: any) => {
        if (worker === 'reviser') reviserCalls++;
        return { text: 'revised\n\nx', costUsd: 0 };
      },
      launchReview: async () => [{ issueId: 'i1', verdict: 'approve' }],
    });
    seedReview(root);
    const state = newState(d.cfg);
    seedIssue(state, 'i1', {
      status: 'NEEDS_REVISION', slot: 0, affectedRepos: ['A'],
      reviewPath: 'reviews/i1.md', reportPath: 'reports/i1.md',
      decision: { issueId: 'i1', verdict: 'approve', comments: 'more' },
    });
    await reviseAndReview(d, state, ['i1']);
    expect(reviserCalls).toBe(1);
    expect(state.issues['i1'].status).toBe('APPROVED');
  });

  const pubWorker = async ({ worker }: any) => ({
    text: worker === 'publisher'
      ? '```json\n{"commitMessage":"c","prTitle":"t","prBody":"b"}\n```'
      : 'x\n\ny',
    costUsd: 0,
  });

  it('publishApproved: full success -> PUSHED with prUrls, slot released', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    let released = 0;
    const d = fakeDeps(root, { runWorker: pubWorker });
    d.pool.release = () => { released++; };
    seedReview(root);
    const state = newState(d.cfg);
    seedIssue(state, 'i1', {
      status: 'APPROVED', slot: 0, affectedRepos: ['A'],
      reviewPath: 'reviews/i1.md', reportPath: 'reports/i1.md',
    });
    await publishApproved(d, state, 'i1');
    expect(state.issues['i1'].status).toBe('PUSHED');
    expect(state.issues['i1'].prUrls).toEqual({ A: 'u' });
    expect(released).toBe(1);
    expect(state.issues['i1'].slot).toBeUndefined();
  });

  it('publishApproved: one repo fails -> PARTIALLY_PUSHED', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root, { runWorker: pubWorker });
    d.cfg.repos = [
      { name: 'A', path: '.', remote: 'origin', provider: 'github' },
      { name: 'B', path: 'B', remote: 'origin', provider: 'github' },
    ];
    const slot2 = { n: 0, dir: join(root, 's'), repoDirs: { A: join(root, 's'), B: join(root, 's/B') }, branch: 'crashfix/x' };
    d.pool.slotByNumber = () => slot2;
    d.git.push = async (dir: string) => { if (dir.endsWith('/B')) throw new Error('push denied'); };
    seedReview(root);
    const state = newState(d.cfg);
    seedIssue(state, 'i1', {
      status: 'APPROVED', slot: 0, affectedRepos: ['A', 'B'],
      reviewPath: 'reviews/i1.md', reportPath: 'reports/i1.md',
    });
    await publishApproved(d, state, 'i1');
    expect(state.issues['i1'].status).toBe('PARTIALLY_PUSHED');
    expect(state.issues['i1'].prUrls).toEqual({ A: 'u' });
  });

  it('publishApproved: every repo fails -> FAILED, not PUSHED', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfx-'));
    const d = fakeDeps(root, { runWorker: pubWorker });
    d.git.push = async () => { throw new Error('push denied'); };
    seedReview(root);
    const state = newState(d.cfg);
    seedIssue(state, 'i1', {
      status: 'APPROVED', slot: 0, affectedRepos: ['A'],
      reviewPath: 'reviews/i1.md', reportPath: 'reports/i1.md',
    });
    await publishApproved(d, state, 'i1');
    expect(state.issues['i1'].status).toBe('FAILED');
    expect(state.issues['i1'].failureStage).toBe('publish');
    expect(state.issues['i1'].notes).toMatch(/publish failed for all repos/);
  });
});

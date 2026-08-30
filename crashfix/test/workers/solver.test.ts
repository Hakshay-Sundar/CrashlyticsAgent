import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/orchestrator/semaphore.js';
import { runSolver } from '../../src/workers/solver.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } } as any;
const slot = { n: 0, dir: '/w/s0', repoDirs: { A: '/w/s0', B: '/w/s0/B' } } as any;
const issue = { id: 'i1', title: 'NPE', type: 'crash', stackTrace: 's' } as any;
const repos = [{ name: 'A', path: '.' }, { name: 'B', path: 'B' }] as any;

function fakeGit(changed: Record<string, string[]>, diff: Record<string, string>) {
  return {
    status: async (cwd: string) => (changed[cwd] ?? []).map((p) => ({ path: p })),
    diff: async (cwd: string) => diff[cwd] ?? '',
  } as any;
}

describe('runSolver', () => {
  it('detects affected repos, renders per-repo diff, validation passes', async () => {
    const runWorker = async () => ({ text: 'Fixed the null deref by guarding feed.\n\ndetails...', costUsd: 0 });
    const git = fakeGit({ '/w/s0': ['app/Feed.kt'], '/w/s0/B': [] }, { '/w/s0': '--- a\n+++ b\n+guard' });
    const r = await runSolver(
      { runWorker, model: 'sonnet', git, sem: new Semaphore(2), log: nolog, validation: 'none', buildTimeoutSec: 60 },
      slot, issue, repos, '# causation');
    expect(r.affectedRepos).toEqual(['A']);
    expect(r.reviewMarkdown).toContain('## Repo A');
    expect(r.reviewMarkdown).toContain('+guard');
    expect(r.reviewMarkdown).not.toContain('## Repo B');
    expect(r.reviewMarkdown).toContain('[Causation report](reports/npe-i1.md)');
    expect(r.selfCorrected).toBe(false);
  });

  it('self-corrects once when validation fails the first time', async () => {
    let calls = 0;
    const runWorker = async () => { calls++; return { text: `attempt ${calls}`, costUsd: 0 }; };
    const git = fakeGit({ '/w/s0': ['A.kt'] }, { '/w/s0': 'diff' });
    let vcalls = 0;
    const sem = new Semaphore(2);
    const exec = async () => { vcalls++; return { code: vcalls === 1 ? 1 : 0, output: vcalls === 1 ? 'BUILD FAILED xyz' : 'ok' }; };
    const r = await runSolver(
      { runWorker, model: 'sonnet', git, sem, log: nolog, validation: 'build', buildTimeoutSec: 60, exec },
      slot, issue, repos, '# causation');
    expect(calls).toBe(2);
    expect(r.selfCorrected).toBe(true);
    expect(r.validation.ok).toBe(true);
  });
});

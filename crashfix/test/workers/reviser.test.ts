import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/orchestrator/semaphore.js';
import { runReviser } from '../../src/workers/reviser.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } };
const slot = { n: 0, dir: '/w/s0', repoDirs: { A: '/w/s0' } } as any;
const issue = { id: 'i1', title: 'NPE', type: 'crash' } as any;
const repos = [{ name: 'A', path: '.' }] as any;
const git = { status: async () => [{ path: 'A.kt' }], diff: async () => 'diff-v2' } as any;

describe('runReviser', () => {
  it('passes the human comments into the worker prompt and re-renders the packet', async () => {
    let seenPrompt = '';
    const runWorker = async (o: any) => { seenPrompt = o.prompt; return { text: 'Addressed the feedback', costUsd: 0 }; };
    const r = await runReviser(
      { runWorker, model: 'sonnet', git, sem: new Semaphore(2), log: nolog, validation: 'none', buildTimeoutSec: 60,
        exec: async () => ({ code: 0, output: '' }) } as any,
      slot, issue, repos, '# causation', 'please also null-check the callback');
    expect(seenPrompt).toContain('please also null-check the callback');
    expect(r.reviewMarkdown).toContain('diff-v2');
  });
});

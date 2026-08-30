import { describe, it, expect } from 'vitest';
import { runAnalyzer } from '../../src/workers/analyzer.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } } as any;
const slot = { n: 0, dir: '/w/slot-0', repoDirs: { A: '/w/slot-0' } } as any;
const issue = { id: 'i1', title: 'NPE', type: 'crash', stackTrace: 'NPE at X.kt:1' } as any;

describe('runAnalyzer', () => {
  it('captures the report and marks FIXABLE', async () => {
    const runWorker = async () => ({ text: '# Causation\nRoot cause: null feed.\n\nVERDICT: FIXABLE', costUsd: 0 });
    const r = await runAnalyzer({ runWorker, model: 'opus', log: nolog }, slot, issue);
    expect(r.unfixable).toBe(false);
    expect(r.reportMarkdown).toContain('Root cause: null feed.');
    expect(r.reportMarkdown).not.toContain('VERDICT:');
  });

  it('marks UNFIXABLE with the stated reason', async () => {
    const runWorker = async () => ({ text: '# Causation\n...\n\nVERDICT: UNFIXABLE — crash is in a third-party .so', costUsd: 0 });
    const r = await runAnalyzer({ runWorker, model: 'opus', log: nolog }, slot, issue);
    expect(r.unfixable).toBe(true);
    expect(r.reason).toMatch(/third-party \.so/);
  });

  it('passes cwd = slot.dir and read-only tools', async () => {
    let seen: any;
    const runWorker = async (o: any) => { seen = o; return { text: 'x\n\nVERDICT: FIXABLE', costUsd: 0 }; };
    await runAnalyzer({ runWorker, model: 'opus', log: nolog }, slot, issue);
    expect(seen.cwd).toBe('/w/slot-0');
    expect(seen.allowedTools.sort()).toEqual(['Glob', 'Grep', 'Read']);
  });
});

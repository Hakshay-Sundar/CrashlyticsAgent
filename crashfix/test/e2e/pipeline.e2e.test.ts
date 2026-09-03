// End-to-end integration test: drives runPipeline with REAL git + real pool +
// real state/report, and fakes only the outside world (connector, workers,
// PR provider/http, review TUI). Three issues across two waves exercise the
// three terminal paths: pushed, revised-then-pushed, rejected. The rejected
// issue sits in wave 0 so the following wave proves its slot is reusable.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realGit as git } from '../../src/git.js';
import { runPipeline } from '../../src/orchestrator/run.js';
import { makeNestedRepos, seedSource } from '../fixtures/repos.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } };
// ledger lives OUTSIDE root: no repo dir the dirty-check scans, and it must
// survive `crashfix clean` (which wipes <root>/.crashfix/)
const ledgerTmp = () => join(mkdtempSync(join(tmpdir(), 'cfx-led-')), 'ledger.json');
const mk = (id: string, over = {}) => ({
  id, title: `crash ${id}`, subtitle: '', type: 'crash', eventCount: 50, userCount: 3,
  firstSeenVersion: '4.0.0', lastSeenVersion: '4.3.0', stackTrace: 'NPE at Feature.kt',
  sampleEventUrl: '', ...over,
});

describe('crashfix e2e', () => {
  it('runs 3 issues: one rejected (wave 0), one pushed, one revised+pushed (wave 1)', async () => {
    const { root } = makeNestedRepos();
    seedSource(root); // root/B/app/Feature.kt with a null-deref, committed in repo B

    // waveSize 2 over [i3, i1, i2] -> wave 0 = [i3 (reject), i1 (push)], wave 1 = [i2].
    // i2 is approved-with-comments the FIRST time it is reviewed, then plain-approved
    // once the reviser has re-run — so it lands PUSHED via the revision loop, and its
    // slot is one freed by wave 0 (proves reject/publish slot release + reuse).
    const seen: Record<string, number> = {};
    const decide = (id: string) => {
      seen[id] = (seen[id] ?? 0) + 1;
      if (id === 'i1') return { verdict: 'approve' };
      if (id === 'i2') return seen.i2 >= 2
        ? { verdict: 'approve' }
        : { verdict: 'approve', comments: 'also guard the second call site' };
      return { verdict: 'reject', comments: 'wrong layer' };
    };
    let reviewRound = 0;
    let fetchCalls = 0;

    const cfg: any = {
      repos: [], concurrency: 2, waveSize: 2, validation: 'none', buildParallelism: 2,
      buildTimeoutSec: 60, defaults: { limit: 25 }, filters: {}, models: {}, issueSource: 'fake',
      ledgerPath: ledgerTmp(),
    };

    const state = await runPipeline({
      root, cfg,
      deps: {
        git, log: nolog,
        connector: {
          key: 'fake',
          fetchTopIssues: async () => { fetchCalls++; return [mk('i3'), mk('i1'), mk('i2')]; },
        },
        runWorker: async (o: any) => {
          if (o.worker === 'analyzer') {
            return { text: '# Causation\nNull feed handler.\n\nVERDICT: FIXABLE', costUsd: 0 };
          }
          if (o.worker === 'solver' || o.worker === 'reviser') {
            const f = join(o.cwd, 'B', 'app', 'Feature.kt');
            writeFileSync(f, readFileSync(f, 'utf8').replace('feed!!', 'feed?'));
            return { text: 'Guarded the null feed access\n\nmore', costUsd: 0 };
          }
          if (o.worker === 'publisher') {
            return {
              text: '```json\n{"commitMessage":"fix: guard null feed","prTitle":"Fix NPE","prBody":"root cause"}\n```',
              costUsd: 0,
            };
          }
          return { text: '', costUsd: 0 };
        },
        provider: () => ({
          name: 'github',
          openPr: async (i: any) => ({ url: `https://gh/${i.branch}`, id: '1' }),
          updatePrBody: async () => {},
        }),
        http: async () => ({ status: 200, json: {} }),
        launchReview: async (items: any[]) => {
          reviewRound++;
          return items.map((it: any) => ({ issueId: it.record.issue.id, ...decide(it.record.issue.id) }));
        },
        exec: async () => ({ code: 0, output: '' }),
      } as any,
    });

    // terminal statuses
    expect(state.issues['i1'].status).toBe('PUSHED');
    expect(state.issues['i2'].status).toBe('PUSHED'); // approve+comments -> revise -> re-review -> push
    expect(state.issues['i3'].status).toBe('REJECTED');
    expect(state.issues['i3'].notes).toMatch(/wrong layer/);
    expect(state.phase).toBe('done');

    // reviews: wave0 [i3,i1] + wave1 [i2] + wave1 re-review of i2 = 3
    expect(reviewRound).toBe(3);
    expect(seen.i2).toBe(2);
    expect(fetchCalls).toBe(1);
    expect(state.waveOrder.length).toBe(2);
    expect(state.waveOrder[0]).toEqual(['i3', 'i1']);
    expect(state.waveOrder[1]).toEqual(['i2']);

    // real PRs opened for the two pushed issues, none for the rejected one
    expect(state.issues['i1'].prUrls.B).toMatch(/^https:\/\/gh\//);
    expect(state.issues['i2'].prUrls.B).toMatch(/^https:\/\/gh\//); // wave-1 issue on a reused slot
    expect(state.issues['i3'].prUrls).toEqual({});

    // durable master report carries PR url + the rejection
    const report = readFileSync(join(root, '.crashfix', 'report.md'), 'utf8');
    expect(report).toContain('https://gh/');
    expect(report).toContain('REJECTED');

    // pool fully torn down — no slot worktrees left in the main checkout
    const wt = await git.worktreeList(root);
    expect(wt.some((w) => w.path.includes('slot-'))).toBe(false);

    // i3's fix branch was deleted from repo B when it was rejected in wave 0
    // (not merely at pool teardown), so it never leaked into wave 1
    const i3Branch = state.issues['i3'].branch;
    await expect(git.revParse(join(root, 'B'), i3Branch)).rejects.toThrow();
  });

  it('writes a ledger + master doc and skips resolved issues on a second run', async () => {
    const { root } = makeNestedRepos();
    seedSource(root);
    // ledger outside root so run 2 (a fresh repo) can share it AND it survives a clean
    const ledgerPath = ledgerTmp();
    const baseCfg: any = {
      repos: [], concurrency: 2, waveSize: 5, validation: 'none', buildParallelism: 2,
      buildTimeoutSec: 60, defaults: { limit: 25 }, filters: {}, models: {}, issueSource: 'fake',
      masterDocPath: '.crashfix/master.md', ledgerPath,
    };
    const deps: any = {
      git, log: nolog,
      connector: {
        key: 'fake',
        fetchTopIssues: async () => [mk('k1')],
      },
      runWorker: async (o: any) => {
        if (o.worker === 'analyzer') return { text: '# c\nx\n\nVERDICT: FIXABLE', costUsd: 0 };
        if (o.worker === 'solver' || o.worker === 'reviser') {
          const f = join(o.cwd, 'B', 'app', 'Feature.kt');
          writeFileSync(f, readFileSync(f, 'utf8').replace('feed!!', 'feed?'));
          return { text: 'fix\n\nmore', costUsd: 0 };
        }
        if (o.worker === 'publisher') {
          return { text: '```json\n{"commitMessage":"fix","prTitle":"t","prBody":"b"}\n```', costUsd: 0 };
        }
        return { text: '', costUsd: 0 };
      },
      provider: () => ({ name: 'github', openPr: async () => ({ url: 'https://gh/pr/1', id: '1' }), updatePrBody: async () => {} }),
      http: async () => ({ status: 200, json: {} }),
      launchReview: async (items: any[]) => items.map((i) => ({ issueId: i.record.issue.id, verdict: 'approve' })),
      exec: async () => ({ code: 0, output: '' }),
    };

    const s1 = await runPipeline({ root, cfg: baseCfg, deps });
    expect(s1.issues.k1.status).toBe('PUSHED');
    expect(existsSync(ledgerPath)).toBe(true);
    expect(existsSync(join(root, '.crashfix', 'master.md'))).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(ledger.entries.k1.status).toBe('PUSHED');

    // `crashfix clean` wipes <root>/.crashfix/ — the ledger lives outside it and survives
    rmSync(join(root, '.crashfix'), { recursive: true, force: true });
    expect(existsSync(ledgerPath)).toBe(true);

    // Second run in a fresh repo but pointed at the SAME external ledger:
    // k1 is already PUSHED there, so only k2 should be processed.
    const { root: root2 } = makeNestedRepos();
    seedSource(root2);
    const s2 = await runPipeline({
      root: root2,
      cfg: { ...baseCfg, ledgerPath },
      deps: {
        ...deps,
        connector: {
          key: 'fake',
          fetchTopIssues: async () => [mk('k1'), mk('k2')],
        },
      },
    });
    expect(Object.keys(s2.issues)).toEqual(['k2']); // k1 skipped — already PUSHED in the shared ledger
  });
});

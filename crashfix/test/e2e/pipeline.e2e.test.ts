// End-to-end integration test: drives runPipeline with REAL git + real pool +
// real state/report, and fakes only the outside world (connector, workers,
// PR provider/http, review TUI). Three issues across two waves exercise the
// three terminal paths: pushed, revised-then-pushed, rejected.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realGit as git } from '../../src/git.js';
import { runPipeline } from '../../src/orchestrator/run.js';
import { makeNestedRepos, seedSource } from '../fixtures/repos.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } };
const mk = (id: string, over = {}) => ({
  id, title: `crash ${id}`, subtitle: '', type: 'crash', eventCount: 50, userCount: 3,
  firstSeenVersion: '4.0.0', lastSeenVersion: '4.3.0', stackTrace: 'NPE at Feature.kt',
  sampleEventUrl: '', ...over,
});

describe('crashfix e2e', () => {
  it('runs 3 issues: one pushed, one revised+pushed, one rejected', async () => {
    const { root } = makeNestedRepos();
    seedSource(root); // root/B/app/Feature.kt with a null-deref, committed in repo B

    // i2 is approved-with-comments the FIRST time it is reviewed, then plain-approved
    // once the reviser has re-run — so it lands PUSHED via the revision loop.
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
    };

    const state = await runPipeline({
      root, cfg,
      deps: {
        git, log: nolog,
        connector: {
          key: 'fake',
          fetchTopIssues: async () => { fetchCalls++; return [mk('i1'), mk('i2'), mk('i3')]; },
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

    // the reviser actually re-ran and got re-reviewed (wave1 review + wave1 re-review + wave2 review)
    expect(reviewRound).toBe(3);
    expect(seen.i2).toBe(2);
    expect(fetchCalls).toBe(1);
    expect(state.waveOrder.length).toBe(2);

    // real PRs opened for the two pushed issues, none for the rejected one
    expect(state.issues['i1'].prUrls.B).toMatch(/^https:\/\/gh\//);
    expect(state.issues['i2'].prUrls.B).toMatch(/^https:\/\/gh\//);
    expect(state.issues['i3'].prUrls).toEqual({});

    // durable master report carries PR url + the rejection
    const report = readFileSync(join(root, '.crashfix', 'report.md'), 'utf8');
    expect(report).toContain('https://gh/');
    expect(report).toContain('REJECTED');

    // pool fully torn down — no slot worktrees left in the main checkout
    const wt = await git.worktreeList(root);
    expect(wt.some((w) => w.path.includes('slot-'))).toBe(false);

    // i3's fix branch is gone from repo B
    const i3Branch = state.issues['i3'].branch;
    await expect(git.revParse(join(root, 'B'), i3Branch)).rejects.toThrow();
  });
});

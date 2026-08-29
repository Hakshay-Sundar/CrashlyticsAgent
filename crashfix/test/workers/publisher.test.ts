import { describe, it, expect } from 'vitest';
import { runPublisherText, publishIssue } from '../../src/workers/publisher.js';

const nolog = { info() {}, warn() {}, error() {}, child() { return this as any; } };

describe('runPublisherText', () => {
  it('parses commit + PR copy from a json block', async () => {
    const runWorker = async () => ({
      text:
        '```json\n' +
        JSON.stringify({ commitMessage: 'fix: guard null feed', prTitle: 'Fix NPE in Feed', prBody: 'Root cause: ...' }) +
        '\n```',
      costUsd: 0,
    });
    const t = await runPublisherText({ runWorker, model: 'haiku' } as any, { id: 'i1' } as any, '# c', 'diff');
    expect(t.commitMessage).toBe('fix: guard null feed');
  });

  it('throws a clear error when a field is missing', async () => {
    const runWorker = async () => ({ text: '```json\n' + JSON.stringify({ commitMessage: 'x', prTitle: 'y' }) + '\n```', costUsd: 0 });
    await expect(runPublisherText({ runWorker, model: 'haiku' } as any, { id: 'i1' } as any, '# c', 'diff')).rejects.toThrow(
      /prBody/,
    );
  });
});

describe('publishIssue', () => {
  const slot = { n: 0, dir: '/w/s0', repoDirs: { A: '/w/s0', B: '/w/s0/B' }, branch: 'crashfix/i1' } as any;
  const repos = [
    { name: 'A', path: '.', remote: 'origin', provider: 'github' },
    { name: 'B', path: 'B', remote: 'origin', provider: 'bitbucket' },
  ] as any;
  const git = {
    add: async () => {},
    commit: async () => 'sha',
    push: async () => {},
    remoteUrl: async () => 'git@x:o/r.git',
  } as any;

  it('opens one PR per affected repo and cross-links them', async () => {
    const bodies: Record<string, string> = {};
    const provider = (p: string) =>
      ({
        name: p,
        openPr: async (i: any) => ({ url: `https://${p}/pr/${i.branch}`, id: '1' }),
        updatePrBody: async (url: string, body: string) => {
          bodies[url] = body;
        },
      }) as any;
    const out = await publishIssue(
      { git, provider, http: (async () => ({ status: 200, json: {} })) as any, log: nolog, base: 'main' },
      slot,
      { id: 'i1', title: 'NPE' } as any,
      repos,
      { commitMessage: 'c', prTitle: 't', prBody: 'b' },
    );
    expect(Object.keys(out.prUrls).sort()).toEqual(['A', 'B']);
    expect(out.partial).toBe(false);
    expect(Object.values(bodies).some((b) => b.includes('Companion PRs'))).toBe(true);
  });

  it('records a partial push when one repo fails', async () => {
    const provider = (p: string) =>
      ({
        name: p,
        openPr: async (_i: any) => {
          if (p === 'bitbucket') throw new Error('403');
          return { url: 'https://gh/pr/1', id: '1' };
        },
        updatePrBody: async () => {},
      }) as any;
    const out = await publishIssue(
      { git, provider, http: (async () => ({ status: 200, json: {} })) as any, log: nolog, base: 'main' },
      slot,
      { id: 'i1', title: 'NPE' } as any,
      repos,
      { commitMessage: 'c', prTitle: 't', prBody: 'b' },
    );
    expect(out.failedRepos).toEqual(['B']);
    expect(out.partial).toBe(true);
    expect(Object.keys(out.prUrls)).toEqual(['A']);
  });

  it('all repos failing → not partial, empty prUrls, all in failedRepos', async () => {
    const provider = (p: string) =>
      ({
        name: p,
        openPr: async () => {
          throw new Error('boom');
        },
        updatePrBody: async () => {},
      }) as any;
    const out = await publishIssue(
      { git, provider, http: (async () => ({ status: 200, json: {} })) as any, log: nolog, base: 'main' },
      slot,
      { id: 'i1', title: 'NPE' } as any,
      repos,
      { commitMessage: 'c', prTitle: 't', prBody: 'b' },
    );
    expect(out.partial).toBe(false);
    expect(out.prUrls).toEqual({});
    expect(out.failedRepos).toEqual(['A', 'B']);
  });

  it('a cross-link updatePrBody throw is non-fatal', async () => {
    const provider = (p: string) =>
      ({
        name: p,
        openPr: async (i: any) => ({ url: `https://${p}/pr/${i.branch}`, id: '1' }),
        updatePrBody: async (url: string) => {
          if (url.includes('bitbucket')) throw new Error('cross-link 500');
        },
      }) as any;
    const out = await publishIssue(
      { git, provider, http: (async () => ({ status: 200, json: {} })) as any, log: nolog, base: 'main' },
      slot,
      { id: 'i1', title: 'NPE' } as any,
      repos,
      { commitMessage: 'c', prTitle: 't', prBody: 'b' },
    );
    expect(out.partial).toBe(false);
    expect(out.failedRepos).toEqual([]);
    expect(Object.keys(out.prUrls).sort()).toEqual(['A', 'B']);
  });
});

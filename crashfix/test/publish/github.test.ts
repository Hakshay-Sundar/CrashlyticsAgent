import { describe, it, expect } from 'vitest';
import { selectProvider } from '../../src/publish/index.js';

describe('github provider', () => {
  it('opens a PR against the parsed owner/repo', async () => {
    const p = selectProvider('github', { GITHUB_TOKEN: 't' } as any);
    const calls: any[] = [];
    const http = async (req: any) => {
      calls.push(req);
      return { status: 201, json: { html_url: 'https://github.com/o/r/pull/7', number: 7 } };
    };
    const r = await p.openPr(
      {
        repoDir: '/w/A',
        remoteUrl: 'git@github.com:o/r.git',
        branch: 'crashfix/x',
        base: 'main',
        title: 'T',
        body: 'B',
      },
      http,
    );
    expect(r.url).toBe('https://github.com/o/r/pull/7');
    expect(r.id).toBe('7');
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/pulls');
    expect(calls[0].headers.Authorization).toMatch(/token t|Bearer t/);
    expect(JSON.parse(calls[0].body)).toMatchObject({ head: 'crashfix/x', base: 'main' });
  });

  it('updatePrBody PATCHes the PR api url', async () => {
    const p = selectProvider('github', { GH_TOKEN: 't' } as any);
    const calls: any[] = [];
    const http = async (req: any) => {
      calls.push(req);
      return { status: 200, json: {} };
    };
    await p.updatePrBody('https://github.com/o/r/pull/7', 'NEW', http);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/7');
    expect(JSON.parse(calls[0].body)).toEqual({ body: 'NEW' });
  });

  it('throws a clear error when GITHUB_TOKEN is unset', () => {
    expect(() => selectProvider('github', {} as any)).toThrow(/GITHUB_TOKEN/);
  });
});

describe('bitbucket provider', () => {
  it('opens a PR against the parsed workspace/slug', async () => {
    const p = selectProvider('bitbucket', { BITBUCKET_TOKEN: 't' } as any);
    const calls: any[] = [];
    const http = async (req: any) => {
      calls.push(req);
      return { status: 201, json: { links: { html: { href: 'https://bitbucket.org/ws/rs/pull-requests/3' } }, id: 3 } };
    };
    const r = await p.openPr(
      {
        repoDir: '/w/A',
        remoteUrl: 'https://bitbucket.org/ws/rs.git',
        branch: 'crashfix/x',
        base: 'main',
        title: 'T',
        body: 'B',
      },
      http,
    );
    expect(r.url).toBe('https://bitbucket.org/ws/rs/pull-requests/3');
    expect(r.id).toBe('3');
    expect(calls[0].url).toBe('https://api.bitbucket.org/2.0/repositories/ws/rs/pullrequests');
    expect(JSON.parse(calls[0].body)).toMatchObject({
      source: { branch: { name: 'crashfix/x' } },
      destination: { branch: { name: 'main' } },
    });
  });

  it('throws when BITBUCKET_TOKEN unset', () => {
    expect(() => selectProvider('bitbucket', {} as any)).toThrow(/BITBUCKET_TOKEN/);
  });
});

describe('gitlab provider', () => {
  it('url-encodes a nested group project path', async () => {
    const p = selectProvider('gitlab', { GITLAB_TOKEN: 't' } as any);
    const calls: any[] = [];
    const http = async (req: any) => {
      calls.push(req);
      return { status: 201, json: { web_url: 'https://gitlab.com/g/sub/r/-/merge_requests/4', iid: 4 } };
    };
    const r = await p.openPr(
      {
        repoDir: '/w/A',
        remoteUrl: 'git@gitlab.com:g/sub/r.git',
        branch: 'crashfix/x',
        base: 'main',
        title: 'T',
        body: 'B',
      },
      http,
    );
    expect(r.url).toBe('https://gitlab.com/g/sub/r/-/merge_requests/4');
    expect(r.id).toBe('4');
    expect(calls[0].url).toBe('https://gitlab.com/api/v4/projects/g%2Fsub%2Fr/merge_requests');
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('t');
    expect(JSON.parse(calls[0].body)).toMatchObject({ source_branch: 'crashfix/x', target_branch: 'main' });
  });

  it('throws when GITLAB_TOKEN unset', () => {
    expect(() => selectProvider('gitlab', {} as any)).toThrow(/GITLAB_TOKEN/);
  });
});

describe('unknown provider', () => {
  it('throws a clear error', () => {
    expect(() => selectProvider('unknown', {} as any)).toThrow();
  });
});

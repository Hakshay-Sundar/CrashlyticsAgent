import type { HttpFn, OpenPrInput, Provider } from './provider.js';
import { parsePath } from './provider.js';

function apiBase(remoteUrl: string): string {
  return `https://api.github.com/repos/${parsePath(remoteUrl)}`;
}

/** github.com PR API url from an html_url like https://github.com/o/r/pull/7 */
function apiUrlFromHtml(htmlUrl: string): string {
  const m = /github\.com\/(.+?)\/pull\/(\d+)/.exec(htmlUrl);
  if (!m) throw new Error(`unrecognised GitHub PR url: ${htmlUrl}`);
  return `https://api.github.com/repos/${m[1]}/pulls/${m[2]}`;
}

export function githubProvider(token: string): Provider {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'crashfix',
    'Content-Type': 'application/json',
  };
  return {
    name: 'github',
    async openPr(i: OpenPrInput, http: HttpFn) {
      const res = await http({
        method: 'POST',
        url: `${apiBase(i.remoteUrl)}/pulls`,
        headers,
        body: JSON.stringify({ title: i.title, head: i.branch, base: i.base, body: i.body }),
      });
      if (res.status >= 300) {
        throw new Error(`GitHub openPr failed (${res.status}): ${JSON.stringify(res.json)}`);
      }
      return { url: res.json.html_url, id: String(res.json.number) };
    },
    async updatePrBody(url: string, body: string, http: HttpFn) {
      const res = await http({
        method: 'PATCH',
        url: apiUrlFromHtml(url),
        headers,
        body: JSON.stringify({ body }),
      });
      if (res.status >= 300) {
        throw new Error(`GitHub updatePrBody failed (${res.status})`);
      }
    },
  };
}

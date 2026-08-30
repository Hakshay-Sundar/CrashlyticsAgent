import type { HttpFn, OpenPrInput, Provider } from './provider.js';
import { parsePath } from './provider.js';

function repoApi(remoteUrl: string): string {
  return `https://api.bitbucket.org/2.0/repositories/${parsePath(remoteUrl)}`;
}

/** PR api url from an html href like https://bitbucket.org/ws/rs/pull-requests/3 */
function apiUrlFromHtml(htmlUrl: string): string {
  const m = /bitbucket\.org\/(.+?)\/pull-requests\/(\d+)/.exec(htmlUrl);
  if (!m) throw new Error(`unrecognised Bitbucket PR url: ${htmlUrl}`);
  return `https://api.bitbucket.org/2.0/repositories/${m[1]}/pullrequests/${m[2]}`;
}

export function bitbucketProvider(token: string): Provider {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  return {
    name: 'bitbucket',
    async openPr(i: OpenPrInput, http: HttpFn) {
      const res = await http({
        method: 'POST',
        url: `${repoApi(i.remoteUrl)}/pullrequests`,
        headers,
        body: JSON.stringify({
          title: i.title,
          source: { branch: { name: i.branch } },
          destination: { branch: { name: i.base } },
          description: i.body,
        }),
      });
      if (res.status >= 300) {
        throw new Error(`Bitbucket openPr failed (${res.status}): ${JSON.stringify(res.json)}`);
      }
      return { url: res.json.links.html.href, id: String(res.json.id) };
    },
    async updatePrBody(url: string, body: string, http: HttpFn) {
      const res = await http({
        method: 'PUT',
        url: apiUrlFromHtml(url),
        headers,
        body: JSON.stringify({ description: body }),
      });
      if (res.status >= 300) {
        throw new Error(`Bitbucket updatePrBody failed (${res.status})`);
      }
    },
  };
}

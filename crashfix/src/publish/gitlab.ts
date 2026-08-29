import type { HttpFn, OpenPrInput, Provider } from './provider.js';
import { parsePath } from './provider.js';

function projectApi(pathOrUrl: string): string {
  return `https://gitlab.com/api/v4/projects/${encodeURIComponent(pathOrUrl)}`;
}

/** MR api url from a web_url like https://gitlab.com/g/sub/r/-/merge_requests/4 */
function apiUrlFromWeb(webUrl: string): string {
  const m = /gitlab\.com\/(.+?)\/-\/merge_requests\/(\d+)/.exec(webUrl);
  if (!m) throw new Error(`unrecognised GitLab MR url: ${webUrl}`);
  return `${projectApi(m[1]!)}/merge_requests/${m[2]}`;
}

export function gitlabProvider(token: string): Provider {
  const headers = {
    'PRIVATE-TOKEN': token,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  return {
    name: 'gitlab',
    async openPr(i: OpenPrInput, http: HttpFn) {
      const res = await http({
        method: 'POST',
        url: `${projectApi(parsePath(i.remoteUrl))}/merge_requests`,
        headers,
        body: JSON.stringify({
          source_branch: i.branch,
          target_branch: i.base,
          title: i.title,
          description: i.body,
        }),
      });
      if (res.status >= 300) {
        throw new Error(`GitLab openPr failed (${res.status}): ${JSON.stringify(res.json)}`);
      }
      return { url: res.json.web_url, id: String(res.json.iid) };
    },
    async updatePrBody(url: string, body: string, http: HttpFn) {
      const res = await http({
        method: 'PUT',
        url: apiUrlFromWeb(url),
        headers,
        body: JSON.stringify({ description: body }),
      });
      if (res.status >= 300) {
        throw new Error(`GitLab updatePrBody failed (${res.status})`);
      }
    },
  };
}

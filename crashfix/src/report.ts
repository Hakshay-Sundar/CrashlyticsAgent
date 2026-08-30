import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunState } from './types.js';

export function slugify(title: string, issueId: string): string {
  const base = title.normalize('NFKD').replace(/[^\x00-\x7F]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = `-${issueId.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
  return (base.slice(0, 48 - suffix.length) + suffix).replace(/^-+|-+$/g, '');
}

export function renderReport(state: RunState): string {
  const recs = Object.values(state.issues);
  const counts: Record<string, number> = {};
  for (const r of recs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const summary = ['## Summary', '', ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`), ''];
  const header = '| Issue | Type | Events | Users | Status | Branch | Slot | Repos | Reports | PRs | Build | Notes |';
  const sep = '|' + '---|'.repeat(12);
  const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = recs.map((r) => {
    const prs = Object.entries(r.prUrls).map(([repo, url]) => `[${repo}](${url})`).join(' ');
    const reports = [r.reportPath && `[analysis](${r.reportPath})`, r.reviewPath && `[review](${r.reviewPath})`]
      .filter(Boolean).join(' ');
    const build = r.buildResult ? (r.buildResult.ok ? 'pass' : 'fail') : '';
    return `| ${cell(r.issue.id)} — ${cell(r.issue.title)} | ${cell(r.issue.type)} | ${r.issue.eventCount} | ${r.issue.userCount} | ${cell(r.status)} | ${cell(r.branch ?? '')} | ${r.slot ?? ''} | ${cell(r.affectedRepos.join(','))} | ${reports} | ${prs} | ${build} | ${cell(r.notes ?? '')} |`;
  });
  const detail = recs.map((r) =>
    `### ${r.issue.id} — ${r.issue.title}\n\n` +
    `Status: **${r.status}** · Branch: \`${r.branch ?? '—'}\`\n\n` +
    (r.reportPath ? `- [Causation report](${r.reportPath})\n` : '') +
    (r.reviewPath ? `- [Review packet](${r.reviewPath})\n` : '') +
    Object.entries(r.prUrls).map(([repo, url]) => `- PR (${repo}): ${url}\n`).join('') +
    (r.notes ? `\n> ${r.notes}\n` : ''),
  );
  return ['# crashfix report', '', ...summary, header, sep, ...rows, '', ...detail].join('\n');
}

export function writeReport(root: string, state: RunState): void {
  const dir = join(root, '.crashfix');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), renderReport(state));
}

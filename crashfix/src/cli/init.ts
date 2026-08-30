import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODELS } from '../config.js';
import { realGit } from '../git.js';
import { discoverRepos } from '../reposcan.js';

const FIREBASE_MCP = {
  mcp: { command: 'npx', args: ['-y', 'firebase-tools', 'experimental:mcp'], env: {} },
};

/**
 * Scan for repos and write/merge crashfix.config.json. Never clobbers an
 * existing firebase/models/connectors block — only fills in what's missing.
 * `force` re-derives the repos list even when one is already present.
 */
export async function initCommand(opts: { cwd: string; force?: boolean }): Promise<void> {
  const { cwd } = opts;
  const cfgPath = join(cwd, 'crashfix.config.json');
  const cfg: Record<string, unknown> = existsSync(cfgPath)
    ? JSON.parse(readFileSync(cfgPath, 'utf8'))
    : {};

  const repos = await discoverRepos(cwd, realGit);
  if (!cfg.repos || opts.force) {
    cfg.repos = repos.map((r) => ({
      name: r.name,
      path: r.path,
      remote: r.remote,
      provider: r.provider,
    }));
  }

  cfg.issueSource ??= 'firebase';
  cfg.models ??= { ...DEFAULT_MODELS };
  const connectors = (cfg.connectors ??= {}) as Record<string, unknown>;
  connectors.firebase ??= FIREBASE_MCP;

  if (!cfg.firebase) {
    const gs = join(cwd, 'google-services.json');
    if (existsSync(gs)) {
      try {
        const j = JSON.parse(readFileSync(gs, 'utf8'));
        const projectId = j?.project_info?.project_id;
        const appId = j?.client?.[0]?.client_info?.mobilesdk_app_id;
        if (projectId && appId) cfg.firebase = { projectId, appId };
      } catch {
        /* malformed google-services.json — leave firebase unset */
      }
    }
  }

  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

  console.log(`Discovered ${repos.length} repo(s):`);
  for (const r of repos) console.log(`  ${r.path}  (${r.provider})`);
  console.log(`\nWrote ${cfgPath}\n`);
  console.log('Checklist:');
  console.log('  [ ] firebase login');
  console.log('  [ ] export GITHUB_TOKEN / BITBUCKET_TOKEN / GITLAB_TOKEN (per repo provider)');
  console.log('  [ ] Claude auth (claude login, or ANTHROPIC_API_KEY)');
}

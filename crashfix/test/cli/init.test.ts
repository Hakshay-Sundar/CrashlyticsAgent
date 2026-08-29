import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initCommand } from '../../src/cli/init.js';
import { makeNestedRepos } from '../fixtures/repos.js';

describe('initCommand', () => {
  it('writes a config with the discovered repos and keeps an existing firebase block', async () => {
    const { root } = makeNestedRepos();
    writeFileSync(
      join(root, 'crashfix.config.json'),
      JSON.stringify({ firebase: { projectId: 'keep-me', appId: 'a' } }),
    );

    await initCommand({ cwd: root, force: true });

    const cfg = JSON.parse(readFileSync(join(root, 'crashfix.config.json'), 'utf8'));
    expect(cfg.firebase.projectId).toBe('keep-me');
    expect(cfg.repos.map((r: { path: string }) => r.path).sort()).toEqual(['.', 'B', 'C']);
    expect(cfg.models.solver).toBe('sonnet');
  });

  it('reads firebase ids from google-services.json when no firebase block is set', async () => {
    const { root } = makeNestedRepos();
    writeFileSync(
      join(root, 'google-services.json'),
      JSON.stringify({
        project_info: { project_id: 'gs-project' },
        client: [{ client_info: { mobilesdk_app_id: '1:2:android:3' } }],
      }),
    );

    await initCommand({ cwd: root });

    const cfg = JSON.parse(readFileSync(join(root, 'crashfix.config.json'), 'utf8'));
    expect(cfg.firebase).toEqual({ projectId: 'gs-project', appId: '1:2:android:3' });
  });
});

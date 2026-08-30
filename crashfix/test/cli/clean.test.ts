import { describe, it, expect } from 'vitest';
import { execaSync } from 'execa';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanCommand } from '../../src/cli/clean.js';
import { realGit } from '../../src/git.js';
import { newState, saveState } from '../../src/state.js';
import { makeNestedRepos } from '../fixtures/repos.js';

describe('cleanCommand', () => {
  it('removes the .crashfix directory when confirmed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'crashfix-clean-')));
    mkdirSync(join(root, '.crashfix'), { recursive: true });
    writeFileSync(join(root, '.crashfix', 'x'), '1');

    await cleanCommand({ cwd: root, yes: true });

    expect(existsSync(join(root, '.crashfix'))).toBe(false);
  });

  it('is a no-op when there is no .crashfix directory', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'crashfix-clean-')));
    await expect(cleanCommand({ cwd: root, yes: true })).resolves.toBeUndefined();
  });

  it('P1: deletes leftover crashfix/<slug> fix branches recorded in state.json', async () => {
    const { root } = makeNestedRepos();
    const repos = [
      { name: 'A', path: '.', remote: 'origin', provider: 'github' },
      { name: 'B', path: 'B', remote: 'origin', provider: 'github' },
    ];
    const branches = ['crashfix/fix-one', 'crashfix/fix-two'];
    for (const b of branches) {
      execaSync('git', ['branch', b], { cwd: root });
      execaSync('git', ['branch', b], { cwd: join(root, 'B') });
    }

    const state = newState({ repos, waveSize: 1, cleanExcludes: [] } as any);
    state.issues.i1 = { issue: { id: 'i1' }, status: 'FAILED', slug: 'fix-one', branch: 'crashfix/fix-one', wave: 0, affectedRepos: [], prUrls: {} } as any;
    state.issues.i2 = { issue: { id: 'i2' }, status: 'IN_REVIEW', slug: 'fix-two', branch: 'crashfix/fix-two', wave: 0, affectedRepos: [], prUrls: {} } as any;
    saveState(root, state);

    await cleanCommand({ cwd: root, yes: true });

    for (const b of branches) {
      await expect(realGit.revParse(root, b)).rejects.toThrow();
      await expect(realGit.revParse(join(root, 'B'), b)).rejects.toThrow();
    }
  });
});

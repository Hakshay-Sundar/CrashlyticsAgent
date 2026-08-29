import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanCommand } from '../../src/cli/clean.js';

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
});

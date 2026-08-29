import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('cli smoke', () => {
  it('prints version', async () => {
    const { stdout } = await execa('npx', ['tsx', cli, '--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('lists subcommands in help', async () => {
    const { stdout } = await execa('npx', ['tsx', cli, '--help']);
    for (const cmd of ['init', 'run', 'resume', 'status', 'clean']) {
      expect(stdout).toContain(cmd);
    }
  });
});

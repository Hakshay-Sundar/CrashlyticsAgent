import { execa } from 'execa';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('unknown subcommand exits non-zero with a message', async () => {
    const err = await execa('npx', ['tsx', cli, 'bogus'], { reject: false });
    expect(err.exitCode).not.toBe(0);
    expect(err.stderr).toMatch(/unknown command/i);
  });

  it('run with no config exits non-zero with a message, not a stack trace', async () => {
    const dir = mkdtempSync(`${tmpdir()}/cfx-noconfig-`);
    const err = await execa('npx', ['tsx', cli, 'run'], { cwd: dir, reject: false });
    expect(err.exitCode).not.toBe(0);
    expect(err.stderr).toMatch(/cannot read .*crashfix\.config\.json/);
    expect(err.stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack frames
  });
});

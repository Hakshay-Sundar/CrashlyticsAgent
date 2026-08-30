import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('build + packaged bin', () => {
  it('tsc builds with no errors', async () => {
    await execa('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], { cwd: root });
  });

  it('the built cli runs --help and lists init & run', async () => {
    await execa('npm', ['run', 'build'], { cwd: root });
    const { stdout } = await execa('node', ['dist/cli.js', '--help'], { cwd: root });
    expect(stdout).toContain('run');
    expect(stdout).toContain('init');
  });

  it('crashfix.config.example.json is valid and loadConfig accepts it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfx-example-'));
    copyFileSync(join(root, 'crashfix.config.example.json'), join(dir, 'crashfix.config.json'));
    const cfg = loadConfig(dir);
    expect(cfg.repos).toHaveLength(3);
    expect(cfg.repos.map((r) => r.name)).toEqual(['A', 'B', 'C']);
    expect(cfg.filters.minAppVersion).toBe('4.2.0');
    expect(cfg.models.analyzer).toBe('opus');
  });
});

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, mergeCliOverrides } from '../src/config.js';

function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cfx-'));
  writeFileSync(join(dir, 'crashfix.config.json'), JSON.stringify(obj));
  return dir;
}

describe('loadConfig', () => {
  it('applies defaults when file is minimal', () => {
    const dir = writeConfig({ firebase: { projectId: 'p', appId: 'a' } });
    const cfg = loadConfig(dir);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.waveSize).toBe(5);
    expect(cfg.validation).toBe('build');
    expect(cfg.buildParallelism).toBe(2);
    expect(cfg.defaults.limit).toBe(25);
    expect(cfg.models.analyzer).toBe('opus');
    expect(cfg.models.solver).toBe('sonnet');
  });

  it('rejects out-of-range concurrency with the json path', () => {
    const dir = writeConfig({ firebase: { projectId: 'p', appId: 'a' }, concurrency: 99 });
    expect(() => loadConfig(dir)).toThrow(/concurrency/);
  });

  it('rejects unknown validation value', () => {
    const dir = writeConfig({ firebase: { projectId: 'p', appId: 'a' }, validation: 'yolo' });
    expect(() => loadConfig(dir)).toThrow(/validation/);
  });

  it('mergeCliOverrides clamps concurrency to waveSize and applies limit', () => {
    const dir = writeConfig({ firebase: { projectId: 'p', appId: 'a' }, waveSize: 3 });
    const cfg = loadConfig(dir);
    const merged = mergeCliOverrides(cfg, { concurrency: 8, limit: 10, type: 'anr' });
    expect(merged.concurrency).toBe(3);
    expect(merged.defaults.limit).toBe(10);
    expect(merged.filters.type).toBe('anr');
  });
});

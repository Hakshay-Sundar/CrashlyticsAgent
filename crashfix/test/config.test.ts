import { describe, it, expect, vi } from 'vitest';
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

  it('warns about unknown top-level keys', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = writeConfig({ firebase: { projectId: 'p', appId: 'a' }, concurency: 9, typo: 'key' });
    const cfg = loadConfig(dir);
    expect(warnSpy).toHaveBeenCalledWith('crashfix.config.json: unknown key "concurency" (ignored)');
    expect(warnSpy).toHaveBeenCalledWith('crashfix.config.json: unknown key "typo" (ignored)');
    expect(cfg.concurrency).toBe(4); // Default, not 9
    warnSpy.mockRestore();
  });

  it('mergeCliOverrides clamps concurrency to waveSize and applies limit', () => {
    const dir = writeConfig({ firebase: { projectId: 'p', appId: 'a' }, waveSize: 3 });
    const cfg = loadConfig(dir);
    const merged = mergeCliOverrides(cfg, { concurrency: 8, limit: 10, type: 'anr' });
    expect(merged.concurrency).toBe(3);
    expect(merged.defaults.limit).toBe(10);
    expect(merged.filters.type).toBe('anr');
    // Also verify clamping for out-of-range overrides
    const merged2 = mergeCliOverrides(cfg, { limit: 999, waveSize: 99, concurrency: 20 });
    expect(merged2.defaults.limit).toBe(25); // Clamped to max
    expect(merged2.waveSize).toBe(10); // Clamped to max
    expect(merged2.concurrency).toBe(8); // Clamped to min(20, 10, 8) = 8
  });
});

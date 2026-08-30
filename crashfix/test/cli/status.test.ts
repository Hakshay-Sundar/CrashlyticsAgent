import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusCommand } from '../../src/cli/status.js';
import { newState, saveState } from '../../src/state.js';
import { loadConfig } from '../../src/config.js';
import { writeFileSync } from 'node:fs';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'crashfix-status-')));
}

describe('statusCommand', () => {
  it('reports when no run is in progress', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    statusCommand({ cwd: tmp() });
    expect(log.mock.calls.flat().join('\n')).toMatch(/no run in progress/i);
    log.mockRestore();
  });

  it('prints the report summary for an existing run', () => {
    const root = tmp();
    writeFileSync(join(root, 'crashfix.config.json'), '{}');
    saveState(root, newState(loadConfig(root)));

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    statusCommand({ cwd: root });
    expect(log.mock.calls.flat().join('\n')).toMatch(/## Summary/);
    log.mockRestore();
  });
});

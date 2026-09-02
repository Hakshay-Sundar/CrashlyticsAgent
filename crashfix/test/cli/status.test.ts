import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusCommand } from '../../src/cli/status.js';

describe('statusCommand', () => {
  it('prints the master doc from the ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfx-'));
    writeFileSync(join(dir, 'crashfix.config.json'), JSON.stringify({
      firebase: { projectId: 'p', appId: 'a' },
      ledgerPath: join(dir, 'led.json'),
    }));
    writeFileSync(join(dir, 'led.json'), JSON.stringify({
      version: 1,
      entries: {
        i1: { id: 'i1', url: 'https://c/i1', title: 'NPE', type: 'crash',
          firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-02T00:00:00.000Z',
          status: 'PUSHED', prUrls: {}, branch: 'crashfix/i1' },
      },
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    statusCommand({ cwd: dir });
    expect(log.mock.calls.flat().join('\n')).toMatch(/master issue log[\s\S]*i1[\s\S]*PUSHED/);
    log.mockRestore();
  });

  it('says nothing recorded when the ledger is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfx-'));
    writeFileSync(join(dir, 'crashfix.config.json'), JSON.stringify({
      firebase: { projectId: 'nope', appId: 'nope' },
      ledgerPath: join(dir, 'absent.json'),
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    statusCommand({ cwd: dir });
    expect(log.mock.calls.flat().join(' ')).toMatch(/no issues recorded yet/);
    log.mockRestore();
  });
});

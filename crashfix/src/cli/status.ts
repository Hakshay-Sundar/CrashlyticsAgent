import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { ledgerPathFor, loadLedger } from '../ledger.js';
import { renderMaster } from '../report.js';

export function statusCommand(opts: { cwd: string }): void {
  let cfg;
  try {
    cfg = loadConfig(opts.cwd);
  } catch {
    console.log('no issues recorded yet');
    return;
  }
  const path = ledgerPathFor(cfg, opts.cwd);
  if (!existsSync(path)) {
    console.log('no issues recorded yet');
    return;
  }
  console.log(renderMaster(loadLedger(path)));
}

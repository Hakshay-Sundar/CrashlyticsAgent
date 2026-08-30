import { renderReport } from '../report.js';
import { loadState } from '../state.js';

export function statusCommand(opts: { cwd: string }): void {
  const state = loadState(opts.cwd);
  if (!state) {
    console.log('no run in progress');
    return;
  }
  console.log(renderReport(state));
}

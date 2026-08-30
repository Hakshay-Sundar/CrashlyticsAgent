import type { CrashfixConfig, RunCliOptions } from '../config.js';
import { loadConfig, mergeCliOverrides } from '../config.js';
import { selectConnector } from '../connectors/index.js';
import { realGit } from '../git.js';
import { createLogger, type Logger } from '../logger.js';
import { runPipeline, resumePipeline, type RunPipelineOptions } from '../orchestrator/run.js';
import { realHttp, selectProvider } from '../publish/index.js';
import { renderReport } from '../report.js';
import { loadState } from '../state.js';
import { launchReview } from '../tui/review.js';
import { realExec } from '../workers/solve-core.js';
import { runWorker } from '../workers/spawn.js';

type CoreDeps = RunPipelineOptions['deps'];

/** Assemble the real production deps shared by `run` and `resume`. */
function buildDeps(cfg: CrashfixConfig, log: Logger): CoreDeps {
  return {
    git: realGit,
    log,
    runWorker,
    connector: selectConnector(cfg.issueSource, cfg, { runWorker, log }),
    provider: (p) => selectProvider(p, process.env),
    http: realHttp,
    launchReview,
    exec: realExec,
  };
}

export async function runCommand(opts: RunCliOptions & { cwd: string }): Promise<void> {
  const cfg = mergeCliOverrides(loadConfig(opts.cwd), opts);
  const log = createLogger();
  const state = await runPipeline({
    root: opts.cwd,
    cfg,
    deps: buildDeps(cfg, log),
    dryRun: opts.dryRun,
    autoApprove: opts.yes,
    force: opts.force,
  });
  console.log(renderReport(state));
}

export async function resumeCommand(opts: { cwd: string }): Promise<void> {
  const state0 = loadState(opts.cwd);
  if (!state0) {
    console.log('no run in progress — run `crashfix run` first');
    return;
  }
  const log = createLogger();
  const state = await resumePipeline(opts.cwd, buildDeps(state0.config, log));
  console.log(renderReport(state));
}

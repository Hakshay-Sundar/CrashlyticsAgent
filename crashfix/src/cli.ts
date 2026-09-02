#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();
program.name('crashfix').version(version);

program.command('init').description('scan repos, write config, verify auth')
  .option('--force', 're-derive the repos list even if one exists')
  .action(async (opts) => { await (await import('./cli/init.js')).initCommand({ cwd: process.cwd(), ...opts }); });
program.command('run').description('run the full fix pipeline')
  .option('--limit <n>', 'max issues', (v) => parseInt(v, 10))
  .option('--min-version <v>').option('--type <crash|anr>')
  .option('--min-events <n>', 'min event count', (v) => parseInt(v, 10))
  .option('--since <date>').option('--concurrency <n>', 'workers', (v) => parseInt(v, 10))
  .option('--wave-size <n>', 'issues per wave', (v) => parseInt(v, 10))
  .option('--source <key>').option('--dry-run').option('--yes').option('--force')
  .option('--issue-url <url>', 'analyse a specific Crashlytics issue (repeatable)',
          (v: string, acc: string[]) => (acc.push(v), acc), [] as string[])
  .action(async (opts) => { await (await import('./cli/run.js')).runCommand({ cwd: process.cwd(), ...opts }); });
program.command('resume').description('continue from state.json')
  .action(async () => { await (await import('./cli/run.js')).resumeCommand({ cwd: process.cwd() }); });
program.command('status').description('print master report summary')
  .action(async () => { (await import('./cli/status.js')).statusCommand({ cwd: process.cwd() }); });
program.command('clean').description('remove all worktrees / crashfix branches / state')
  .option('--yes', 'skip the confirmation prompt')
  .action(async (opts) => { await (await import('./cli/clean.js')).cleanCommand({ cwd: process.cwd(), ...opts }); });

program.parseAsync().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});

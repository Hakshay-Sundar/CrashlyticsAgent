#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();
program.name('crashfix').version(version);

program.command('init').description('scan repos, write config, verify auth')
  .action(async () => { (await import('./cli/init.js')).initCommand(); });
program.command('run').description('run the full fix pipeline')
  .option('--limit <n>', 'max issues', (v) => parseInt(v, 10))
  .option('--min-version <v>').option('--type <crash|anr>')
  .option('--min-events <n>', 'min event count', (v) => parseInt(v, 10))
  .option('--since <date>').option('--concurrency <n>', 'workers', (v) => parseInt(v, 10))
  .option('--wave-size <n>', 'issues per wave', (v) => parseInt(v, 10))
  .option('--source <key>').option('--dry-run').option('--yes').option('--force')
  .action(async (opts) => { (await import('./cli/run.js')).runCommand(opts); });
program.command('resume').description('continue from state.json')
  .action(async () => { (await import('./cli/run.js')).resumeCommand(); });
program.command('status').description('print master report summary')
  .action(async () => { (await import('./cli/status.js')).statusCommand(); });
program.command('clean').description('remove all worktrees / crashfix branches / state')
  .action(async () => { (await import('./cli/clean.js')).cleanCommand(); });

program.parseAsync();

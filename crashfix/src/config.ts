import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export type WorkerName =
  | 'orchestrator'
  | 'fetcher'
  | 'triager'
  | 'analyzer'
  | 'solver'
  | 'reviser'
  | 'publisher'
  | 'reporter';

export const DEFAULT_MODELS: Record<WorkerName, string> = {
  orchestrator: 'opus',
  fetcher: 'haiku',
  triager: 'haiku',
  analyzer: 'opus',
  solver: 'sonnet',
  reviser: 'sonnet',
  publisher: 'haiku',
  reporter: 'haiku',
};

const mcpStdio = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

const repoSchema = z.object({
  name: z.string(),
  path: z.string(),
  remote: z.string().default('origin'),
  provider: z.enum(['github', 'bitbucket', 'gitlab', 'unknown']).default('unknown'),
  buildCommand: z.string().optional(),
});

const schema = z.object({
  firebase: z.object({ projectId: z.string(), appId: z.string() }).optional(),
  issueSource: z.string().default('firebase'),
  connectors: z
    .record(z.string(), z.object({ mcp: mcpStdio }))
    .default({
      firebase: { mcp: { command: 'npx', args: ['-y', 'firebase-tools', 'experimental:mcp'] } },
    }),
  repos: z.array(repoSchema).default([]),
  concurrency: z.number().int().min(1).max(8).default(4),
  waveSize: z.number().int().min(1).max(10).default(5),
  validation: z.enum(['build', 'lint', 'none']).default('build'),
  buildParallelism: z.number().int().min(1).max(4).default(2),
  buildTimeoutSec: z.number().int().min(60).default(1800),
  cleanExcludes: z.array(z.string()).default(['.gradle/', 'local.properties', '*.iml']),
  models: z
    .object({
      orchestrator: z.string(),
      fetcher: z.string(),
      triager: z.string(),
      analyzer: z.string(),
      solver: z.string(),
      reviser: z.string(),
      publisher: z.string(),
      reporter: z.string(),
    })
    .partial()
    .default({})
    .transform((m) => ({ ...DEFAULT_MODELS, ...m })),
  defaults: z
    .object({ limit: z.number().int().min(1).max(25).default(25) })
    .default({ limit: 25 }),
  filters: z
    .object({
      minAppVersion: z.string().nullable().default(null),
      type: z.enum(['crash', 'anr']).nullable().default(null),
      minEventCount: z.number().int().nullable().default(null),
      since: z.string().nullable().default(null),
    })
    .default({
      minAppVersion: null,
      type: null,
      minEventCount: null,
      since: null,
    }),
});

export type CrashfixConfig = z.infer<typeof schema>;

export interface RunCliOptions {
  limit?: number;
  minVersion?: string;
  type?: 'crash' | 'anr';
  minEvents?: number;
  since?: string;
  concurrency?: number;
  waveSize?: number;
  source?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function loadConfig(root: string): CrashfixConfig {
  const path = join(root, 'crashfix.config.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (!first) throw new Error(`invalid config: unknown error`);
    throw new Error(`invalid config at "${first.path.join('.')}": ${first.message}`);
  }
  return parsed.data;
}

export function mergeCliOverrides(cfg: CrashfixConfig, o: RunCliOptions): CrashfixConfig {
  const waveSize = o.waveSize ?? cfg.waveSize;
  const concurrency = Math.min(o.concurrency ?? cfg.concurrency, waveSize);
  return {
    ...cfg,
    waveSize,
    concurrency,
    issueSource: o.source ?? cfg.issueSource,
    defaults: { limit: o.limit ?? cfg.defaults.limit },
    filters: {
      minAppVersion: o.minVersion ?? cfg.filters.minAppVersion,
      type: o.type ?? cfg.filters.type,
      minEventCount: o.minEvents ?? cfg.filters.minEventCount,
      since: o.since ?? cfg.filters.since,
    },
  };
}

import { z } from 'zod';
import type { Issue } from '../types.js';
import type { ConnectorFactory } from './contract.js';

// NOTE: verify against installed firebase-tools — these experimental Crashlytics
// MCP tool names drift between firebase-tools releases. They are passed to the
// fetcher model as guidance only; the model discovers the real tools at runtime.
const MCP_TOOL_HINTS = [
  'crashlytics_list_top_issues',
  'crashlytics_get_issue',
  'crashlytics_list_sample_events',
];

const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().default(''),
  type: z.enum(['crash', 'anr']),
  eventCount: z.number(),
  userCount: z.number(),
  firstSeenVersion: z.string(),
  lastSeenVersion: z.string(),
  stackTrace: z.string(),
  sampleEventUrl: z.string().default(''),
  blameFile: z.string().optional(),
});

function extractJsonBlock(text: string): unknown {
  const m = /```json\s*([\s\S]*?)```/.exec(text) ?? /```\s*([\s\S]*?)```/.exec(text);
  if (!m) throw new Error('fetcher returned no json block');
  return JSON.parse(m[1] ?? '');
}

export const firebaseFactory: ConnectorFactory = ({ runWorker, mcp, log }) => ({
  key: 'firebase',
  async fetchTopIssues({ limit, filters }) {
    const prompt = [
      `List the top ${limit} Crashlytics issues for this app.`,
      `Filters: ${JSON.stringify(filters)}. Apply them; if the API cannot, filter yourself.`,
      `Use the Firebase MCP tools (likely named ${MCP_TOOL_HINTS.join(', ')}; discover the`,
      `actual tool names at runtime) to fetch issue metadata and a representative stack trace.`,
      `Respond with ONLY a fenced \`\`\`json block: {"issues":[{id,title,subtitle,type,`,
      `eventCount,userCount,firstSeenVersion,lastSeenVersion,stackTrace,sampleEventUrl}]}`,
    ].join('\n');

    const { text } = await runWorker({
      worker: 'fetcher',
      model: 'haiku',
      cwd: process.cwd(),
      systemPrompt:
        'You are a data-extraction agent for Firebase Crashlytics. Output only what is asked.',
      prompt,
      allowedTools: ['mcp__firebase'],
      mcpServers: mcp ? { firebase: mcp } : undefined,
    });

    const parsed = extractJsonBlock(text) as { issues?: unknown[] };
    const out: Issue[] = [];
    for (const raw of parsed.issues ?? []) {
      const r = issueSchema.safeParse(raw);
      if (r.success) out.push(r.data);
      else log.warn('dropping malformed issue from fetcher', r.error.issues[0]);
    }
    return out.slice(0, limit);
  },
});

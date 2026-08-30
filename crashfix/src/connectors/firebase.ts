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
  // Normalize casing / common synonyms so a model emitting "ANR" or "fatal"
  // doesn't cost us the whole issue.
  type: z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const t = v.toLowerCase().trim();
    if (t === 'fatal' || t === 'crash') return 'crash';
    if (t === 'anr' || t === 'non-fatal' || t === 'nonfatal') return 'anr';
    return t;
  }, z.enum(['crash', 'anr'])),
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
  try {
    return JSON.parse(m[1] ?? '');
  } catch (e) {
    throw new Error('fetcher returned a malformed json block: ' + (e as Error).message);
  }
}

export const firebaseFactory: ConnectorFactory = ({ runWorker, mcp, log, project }) => ({
  key: 'firebase',
  async fetchTopIssues({ limit, filters }) {
    const target = project?.projectId
      ? `Firebase project "${project.projectId}", app id "${project.appId}".`
      : `the Firebase project configured for this directory.`;
    const prompt = [
      `List the top ${limit} Crashlytics issues for ${target}`,
      `Pass the project id and app id to the MCP tools if they take them.`,
      `Filters: ${JSON.stringify(filters)}. Apply them; if the API cannot, filter yourself.`,
      `Use the Firebase MCP tools (likely named ${MCP_TOOL_HINTS.join(', ')}; discover the`,
      `actual tool names at runtime) to fetch issue metadata and a representative stack trace.`,
      `type must be exactly "crash" or "anr" (lowercase).`,
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
    if (!Array.isArray(parsed.issues)) {
      log.warn('fetcher response had no "issues" array', parsed);
      return [];
    }
    const out: Issue[] = [];
    for (const raw of parsed.issues) {
      const r = issueSchema.safeParse(raw);
      if (r.success) out.push(r.data);
      else log.warn('dropping malformed issue from fetcher', r.error.issues[0]);
    }
    return out.slice(0, limit);
  },
});

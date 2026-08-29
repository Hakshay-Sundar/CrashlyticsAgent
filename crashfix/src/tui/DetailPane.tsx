import { Box, Text } from 'ink';
import type { ReviewItem } from './useReviewStore.js';

export function sectionText(md: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const m = re.exec(md);
  if (!m) return '';
  const rest = md.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

export function diffBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /```diff\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) out.push((m[1] ?? '').replace(/\s+$/, ''));
  return out;
}

export function DetailPane({ item, tab }: { item: ReviewItem; tab: 'summary' | 'diff' }) {
  const { issue, status, affectedRepos } = item.record;
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
      <Text bold>
        {issue.title}  [{tab === 'summary' ? 'Summary' : 'Diff'}]
      </Text>
      <Text dimColor>
        {status} · repos: {(affectedRepos ?? []).join(', ') || '—'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {tab === 'summary' ? (
          <Text>{sectionText(item.reviewMarkdown, 'Summary') || '(no summary)'}</Text>
        ) : (
          <Text>{diffBlocks(item.reviewMarkdown).join('\n\n') || '(no diff)'}</Text>
        )}
      </Box>
    </Box>
  );
}

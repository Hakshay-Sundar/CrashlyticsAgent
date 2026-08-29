import { Box, Text } from 'ink';
import type { StoreState } from './useReviewStore.js';

const glyph = (verdict: string | undefined): string => {
  switch (verdict) {
    case 'approve':
      return '✓'; // ✓
    case 'reject':
      return '✗'; // ✗
    case 'skip':
      return '→'; // →
    default:
      return '○'; // ○
  }
};

export function IssueList({ state }: { state: StoreState }) {
  return (
    <Box flexDirection="column" width={40} borderStyle="round" paddingX={1}>
      <Text bold>Issues</Text>
      {state.items.map((it, i) => {
        const id = it.record.issue.id;
        const selected = i === state.cursor;
        return (
          <Text key={id} inverse={selected} wrap="truncate">
            {glyph(state.decisions.get(id)?.verdict)} {id} {it.record.issue.title}
          </Text>
        );
      })}
    </Box>
  );
}

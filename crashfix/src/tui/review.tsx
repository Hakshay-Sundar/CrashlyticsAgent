import { useReducer } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import type { Decision } from '../types.js';
import { reduce, initialState, type ReviewItem } from './useReviewStore.js';
import { IssueList } from './IssueList.js';
import { DetailPane } from './DetailPane.js';

export type { ReviewItem };

export function ReviewApp({ items, onDone }: { items: ReviewItem[]; onDone: (decisions: Decision[]) => void }) {
  const [state, dispatch] = useReducer(reduce, items, initialState);
  const { exit } = useApp();
  const current = state.items[state.cursor];

  useInput((input, key) => {
    if (state.mode !== 'list') {
      if (key.return) {
        dispatch(state.mode === 'comment' ? { type: 'submitComment' } : { type: 'submitReject' });
      } else if (key.backspace || key.delete) {
        dispatch({ type: 'setDraft', draft: state.draft.slice(0, -1) });
      } else if (key.escape) {
        dispatch({ type: 'cancel' });
      } else if (input && !key.ctrl && !key.meta) {
        dispatch({ type: 'setDraft', draft: state.draft + input });
      }
      return;
    }
    if (key.upArrow) dispatch({ type: 'up' });
    else if (key.downArrow) dispatch({ type: 'down' });
    else if (key.tab) dispatch({ type: 'tab' });
    else if (input === 'a') dispatch({ type: 'approve' });
    else if (input === 'c') dispatch({ type: 'startComment' });
    else if (input === 'r') dispatch({ type: 'startReject' });
    else if (input === 's') dispatch({ type: 'skip' });
    else if (input === 'q') {
      const finalized = reduce(state, { type: 'finalize' }).decisions;
      onDone(items.map((it) => finalized.get(it.record.issue.id)!));
      exit();
    }
  });

  let approved = 0;
  let rejected = 0;
  for (const it of state.items) {
    const v = state.decisions.get(it.record.issue.id)?.verdict;
    if (v === 'approve') approved++;
    else if (v === 'reject') rejected++;
  }
  const pending = state.items.length - state.decisions.size;

  return (
    <Box flexDirection="column">
      <Box>
        <IssueList state={state} />
        {current ? <DetailPane item={current} tab={state.tab} /> : <Text>(no issues)</Text>}
      </Box>
      {state.mode === 'list' ? (
        <Text dimColor>
          ↑/↓ move · tab tab · a approve · c comment · r reject · s skip · q quit
        </Text>
      ) : (
        <Text>
          {state.mode === 'comment' ? 'Comment' : 'Reject reason'}: {state.draft}
          <Text dimColor> (Enter to submit)</Text>
        </Text>
      )}
      <Text>
        approved {approved} · rejected {rejected} · pending {pending}
      </Text>
    </Box>
  );
}

export function launchReview(
  items: ReviewItem[],
  opts?: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream },
): Promise<Decision[]> {
  return new Promise((resolve) => {
    const { unmount } = render(
      <ReviewApp
        items={items}
        onDone={(decisions) => {
          resolve(decisions);
          unmount();
        }}
      />,
      {
        stdin: opts?.stdin ?? process.stdin,
        stdout: opts?.stdout ?? process.stdout,
        exitOnCtrlC: false,
      },
    );
  });
}

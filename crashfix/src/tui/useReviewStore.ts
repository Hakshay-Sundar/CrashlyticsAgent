import type { IssueRecord, Decision } from '../types.js';

export interface ReviewItem {
  record: IssueRecord;
  reviewMarkdown: string;
}

export interface StoreState {
  items: ReviewItem[];
  cursor: number;
  tab: 'summary' | 'diff';
  mode: 'list' | 'comment' | 'reject';
  draft: string;
  decisions: Map<string, Decision>;
}

export const initialState = (items: ReviewItem[]): StoreState => ({
  items,
  cursor: 0,
  tab: 'summary',
  mode: 'list',
  draft: '',
  decisions: new Map(),
});

export type Action =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'tab' }
  | { type: 'skip' }
  | { type: 'approve' }
  | { type: 'startComment' }
  | { type: 'submitComment' }
  | { type: 'startReject' }
  | { type: 'submitReject' }
  | { type: 'cancel' }
  | { type: 'setDraft'; draft: string }
  | { type: 'finalize' };

export function reduce(s: StoreState, a: Action): StoreState {
  const id = s.items[s.cursor]?.record.issue.id ?? '';
  const advance = (d: Map<string, Decision>): StoreState => ({
    ...s,
    decisions: d,
    cursor: Math.min(s.cursor + 1, s.items.length - 1),
    mode: 'list',
    draft: '',
  });
  const set = (dec: Decision) => new Map(s.decisions).set(dec.issueId, dec);
  switch (a.type) {
    case 'up':
      return { ...s, cursor: Math.max(0, s.cursor - 1) };
    case 'down':
      return { ...s, cursor: Math.min(s.items.length - 1, s.cursor + 1) };
    case 'tab':
      return { ...s, tab: s.tab === 'summary' ? 'diff' : 'summary' };
    case 'skip':
      return advance(set({ issueId: id, verdict: 'skip' }));
    case 'approve':
      return advance(set({ issueId: id, verdict: 'approve' }));
    case 'startComment':
      return { ...s, mode: 'comment', draft: '' };
    case 'startReject':
      return { ...s, mode: 'reject', draft: '' };
    case 'cancel':
      return { ...s, mode: 'list', draft: '' };
    case 'setDraft':
      return { ...s, draft: a.draft };
    case 'submitComment':
      return advance(set({ issueId: id, verdict: 'approve', comments: s.draft }));
    case 'submitReject':
      return advance(set({ issueId: id, verdict: 'reject', comments: s.draft }));
    case 'finalize': {
      const d = new Map(s.decisions);
      for (const it of s.items) {
        if (!d.has(it.record.issue.id)) {
          d.set(it.record.issue.id, { issueId: it.record.issue.id, verdict: 'skip' });
        }
      }
      return { ...s, decisions: d };
    }
  }
}

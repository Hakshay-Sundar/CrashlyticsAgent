import { describe, it, expect } from 'vitest';
import { reduce, initialState } from '../../src/tui/useReviewStore.js';

const items = [
  { record: { issue: { id: 'i1', title: 'A' }, status: 'IN_REVIEW' }, reviewMarkdown: '## Summary\nx\n\n## Repo A\n```diff\n+a\n```' },
  { record: { issue: { id: 'i2', title: 'B' }, status: 'IN_REVIEW' }, reviewMarkdown: '## Summary\ny' },
] as any;

describe('review store reduce', () => {
  it('approve records a decision and advances the cursor', () => {
    let s = initialState(items);
    s = reduce(s, { type: 'approve' });
    expect(s.decisions.get('i1')).toEqual({ issueId: 'i1', verdict: 'approve' });
    expect(s.cursor).toBe(1);
  });

  it('comment mode captures a draft then stores approve+comments', () => {
    let s = initialState(items);
    s = reduce(s, { type: 'startComment' });
    s = reduce(s, { type: 'setDraft', draft: 'also guard the callback' });
    s = reduce(s, { type: 'submitComment' });
    expect(s.decisions.get('i1')).toEqual({ issueId: 'i1', verdict: 'approve', comments: 'also guard the callback' });
    expect(s.mode).toBe('list');
  });

  it('reject requires a reason and stores verdict reject', () => {
    let s = initialState(items);
    s = reduce(s, { type: 'startReject' });
    s = reduce(s, { type: 'setDraft', draft: 'not a real fix' });
    s = reduce(s, { type: 'submitReject' });
    expect(s.decisions.get('i1')).toEqual({ issueId: 'i1', verdict: 'reject', comments: 'not a real fix' });
  });

  it('cancel exits comment mode without recording a decision', () => {
    let s = initialState(items);
    s = reduce(s, { type: 'startComment' });
    s = reduce(s, { type: 'setDraft', draft: 'half-written note' });
    s = reduce(s, { type: 'cancel' });
    expect(s.mode).toBe('list');
    expect(s.draft).toBe('');
    expect(s.decisions.has('i1')).toBe(false);
  });

  it('finalize fills untouched items with skip', () => {
    let s = initialState(items);
    s = reduce(s, { type: 'approve' });          // i1
    const decisions = reduce(s, { type: 'finalize' }).decisions;
    expect(decisions.get('i2')).toEqual({ issueId: 'i2', verdict: 'skip' });
  });
});

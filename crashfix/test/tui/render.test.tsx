import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { ReviewApp } from '../../src/tui/review.js';

describe('ReviewApp render', () => {
  it('shows the first issue title and the Summary tab', () => {
    const { lastFrame } = render(<ReviewApp items={[{ record: { issue: { id: 'i1', title: 'NPE Feed' }, status: 'IN_REVIEW', affectedRepos: ['A'] }, reviewMarkdown: '## Summary\nGuarded null' }] as any} onDone={() => {}} />);
    expect(lastFrame()).toContain('NPE Feed');
    expect(lastFrame()).toContain('Guarded null');
  });
});

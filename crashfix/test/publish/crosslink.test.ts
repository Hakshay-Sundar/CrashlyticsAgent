import { describe, it, expect } from 'vitest';
import { crossLinkBodies } from '../../src/publish/crosslink.js';

describe('crossLinkBodies', () => {
  it('adds companion links to each body', () => {
    const m = crossLinkBodies(
      [
        { repo: 'A', url: 'https://gh/pr/1' },
        { repo: 'B', url: 'https://bb/pr/9' },
      ],
      'Fixes crash i1',
    );
    expect(m.get('A')).toContain('https://bb/pr/9');
    expect(m.get('A')).not.toContain('https://gh/pr/1');
    expect(m.get('B')).toContain('https://gh/pr/1');
  });
  it('emits the exact companion section format', () => {
    const m = crossLinkBodies(
      [
        { repo: 'A', url: 'https://gh/pr/1' },
        { repo: 'B', url: 'https://bb/pr/9' },
        { repo: 'C', url: 'https://gl/mr/3' },
      ],
      'Fixes crash i1',
    );
    expect(m.get('A')).toBe(
      'Fixes crash i1\n\n---\n**Companion PRs:** B: https://bb/pr/9 · C: https://gl/mr/3',
    );
  });
  it('no companion section for a single PR', () => {
    const m = crossLinkBodies([{ repo: 'A', url: 'u' }], 'body');
    expect(m.get('A')).toBe('body');
  });
});

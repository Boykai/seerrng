import { describe, expect, it } from 'vitest';
import { stableSearchResults } from './stableSearchResults';

const keyOf = (result: { id: string }) => result.id;

describe('stableSearchResults', () => {
  it('appends newly loaded results without moving cards already on screen', () => {
    const results = [
      { id: 'newer' },
      { id: 'newly-loaded-middle' },
      { id: 'older' },
      { id: 'newly-loaded-last' },
    ];

    expect(
      stableSearchResults(results, ['newer', 'older'], keyOf).map(
        (result) => result.id
      )
    ).toEqual(['newer', 'older', 'newly-loaded-middle', 'newly-loaded-last']);
  });

  it('updates and removes existing results without retaining stale cards', () => {
    const results = [{ id: 'second', title: 'updated' }, { id: 'new' }];

    expect(stableSearchResults(results, ['first', 'second'], keyOf)).toEqual([
      { id: 'second', title: 'updated' },
      { id: 'new' },
    ]);
  });
});

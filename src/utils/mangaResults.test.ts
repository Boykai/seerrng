import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMangaResult } from './mangaResults';

describe('isMangaResult', () => {
  it('matches manga results only', () => {
    assert.equal(isMangaResult({ mediaType: 'manga' }), true);
    for (const mediaType of ['movie', 'tv', 'book', 'comic', 'magazine']) {
      assert.equal(isMangaResult({ mediaType }), false);
    }
    assert.equal(isMangaResult({}), false);
  });

  it('drops manga from a mixed result list without touching other results', () => {
    const results = [
      { id: 1, mediaType: 'movie' },
      { id: 2, mediaType: 'manga' },
      { id: 3, mediaType: 'comic' },
    ];

    assert.deepEqual(
      results.filter((result) => !isMangaResult(result)).map(({ id }) => id),
      [1, 3]
    );
  });
});

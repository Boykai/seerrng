import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasMdblistRatingScores,
  MAX_MDBLIST_RATING_BATCH_SIZE,
  parseMdblistRatingBatchIds,
} from './ratings';

describe('MDBList ratings contracts', () => {
  it('only treats finite score values as an available rating', () => {
    assert.equal(hasMdblistRatingScores(null), false);
    assert.equal(hasMdblistRatingScores({ imdbId: 'tt1234567' }), false);
    assert.equal(hasMdblistRatingScores({ traktVotes: 20_000 }), false);
    assert.equal(hasMdblistRatingScores({ metacriticRating: 0 }), true);
    assert.equal(hasMdblistRatingScores({ imdbRating: Number.NaN }), false);
  });

  it('validates and deduplicates bounded TMDB ID batches', () => {
    assert.deepEqual(parseMdblistRatingBatchIds([10, 20, 10]), [10, 20]);
    assert.equal(parseMdblistRatingBatchIds(undefined), undefined);
    assert.equal(parseMdblistRatingBatchIds([]), undefined);
    assert.equal(parseMdblistRatingBatchIds([1, '2']), undefined);
    assert.equal(parseMdblistRatingBatchIds([1, 0]), undefined);
    assert.equal(parseMdblistRatingBatchIds([1, 1_000_000_001]), undefined);
    assert.equal(
      parseMdblistRatingBatchIds(
        Array.from(
          { length: MAX_MDBLIST_RATING_BATCH_SIZE + 1 },
          (_, i) => i + 1
        )
      ),
      undefined
    );
  });
});

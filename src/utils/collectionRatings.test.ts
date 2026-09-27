import type { RatingResponse } from '@server/api/ratings';
import { describe, expect, it } from 'vitest';
import {
  averageCollectionRatings,
  getCollectionMemberRatings,
} from './collectionRatings';

const part = (id: number, voteAverage = 8, voteCount = 10) => ({
  id,
  voteAverage,
  voteCount,
});
const member = (
  id: number,
  critics: number,
  audience: number,
  imdb: number
) => ({
  id,
  failed: false,
  ratings: {
    rt: { criticsScore: critics, audienceScore: audience },
    imdb: { criticsScore: imdb },
  } as RatingResponse,
});
describe('collection averages', () => {
  it('keeps member ratings in TMDB, critics, audience, IMDb order', () => {
    expect(
      getCollectionMemberRatings(part(1)).map((rating) => rating.source)
    ).toEqual(['tmdb', 'critics', 'audience', 'imdb']);
  });
  it('averages each title equally and each source separately, not by vote count', () => {
    const result = averageCollectionRatings(
      [part(1, 6, 1), part(2, 8, 1000)],
      [member(1, 40, 60, 6), member(2, 80, 100, 8)]
    );
    expect(result.map((r) => r.value)).toEqual([60, 80, 7, 70]);
    expect(result.map((r) => r.count)).toEqual([2, 2, 2, 2]);
  });
  it('excludes missing ratings and unrated TMDB titles, retaining valid zeroes', () => {
    const result = averageCollectionRatings(
      [part(1, 0, 1), part(2, 9, 0)],
      [member(1, 0, 0, 0)]
    );
    expect(result.map((r) => r.value)).toEqual([0, 0, 0, 0]);
    expect(result.map((r) => r.count)).toEqual([1, 1, 1, 1]);
  });
  it('deduplicates titles', () => {
    expect(averageCollectionRatings([part(1), part(1)])[3]).toMatchObject({
      value: 80,
      count: 1,
    });
  });
  it('returns missing values, not zero averages, for empty collections', () => {
    expect(
      averageCollectionRatings([]).every(
        (r) => r.value === undefined && r.count === 0
      )
    ).toBe(true);
  });
  it('rejects invalid, out of range and nonfinite ratings', () => {
    const result = getCollectionMemberRatings(
      part(1, Infinity),
      member(1, -1, 101, NaN).ratings
    );
    expect(result.every((r) => r.value === undefined)).toBe(true);
  });
});

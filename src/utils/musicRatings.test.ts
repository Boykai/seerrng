import { expect, it } from 'vitest';
import { averageMusicRatings } from './musicRatings';

it('averages each provider separately, excluding missing ratings without vote weighting', () => {
  const result = averageMusicRatings([
    [
      { source: 'musicbrainz', score: 8, votes: 10, url: '' },
      { source: 'discogs', score: 4, scale: 5, votes: 100, url: '' },
    ],
    [
      { source: 'musicbrainz', score: 6, votes: 100, url: '' },
      { source: 'theaudiodb', score: 9, scale: 10, votes: 2, url: '' },
    ],
    [],
  ]);
  expect(result.find((r) => r.source === 'musicbrainz')).toMatchObject({
    score: 7,
    ratedAlbums: 2,
    scale: 10,
  });
  expect(result.find((r) => r.source === 'discogs')).toMatchObject({
    score: 4,
    ratedAlbums: 1,
    scale: 5,
  });
  expect(result.find((r) => r.source === 'theaudiodb')).toMatchObject({
    score: 9,
    ratedAlbums: 1,
  });
});

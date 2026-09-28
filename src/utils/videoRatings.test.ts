import type { RatingResponse } from '@server/api/ratings';
import { describe, expect, it } from 'vitest';
import { getEffectiveVideoRatings } from './videoRatings';

describe('effective movie and TV ratings', () => {
  it('uses MDBList values when direct Rotten Tomatoes and IMDb ratings are missing', () => {
    expect(
      getEffectiveVideoRatings({
        mdblist: {
          imdbId: 'tt1234567',
          imdbRating: 8.2,
          imdbVotes: 456,
          rtRating: 77,
          rtUserRating: 54,
        },
      })
    ).toEqual({
      rtCriticsScore: 77,
      rtCriticsRating: 'Fresh',
      rtAudienceScore: 54,
      rtAudienceRating: 'Spilled',
      rtUrl: undefined,
      imdbScore: 8.2,
      imdbVotes: 456,
      imdbUrl: 'https://www.imdb.com/title/tt1234567',
    });
  });

  it('prefers direct ratings and ignores malformed or out of range MDBList scores', () => {
    const response: RatingResponse = {
      rt: {
        title: 'Example',
        year: 2026,
        criticsRating: 'Certified Fresh',
        criticsScore: 96,
        audienceRating: 'Upright',
        audienceScore: 91,
        url: 'https://www.rottentomatoes.com/m/example',
      },
      imdb: {
        title: 'Example',
        url: 'https://www.imdb.com/title/tt1234567',
        criticsScore: 9.1,
        criticsScoreCount: 1000,
      },
      mdblist: {
        imdbRating: 0,
        rtRating: 101,
        rtUserRating: -1,
      },
    };

    expect(getEffectiveVideoRatings(response)).toEqual({
      rtCriticsScore: 96,
      rtCriticsRating: 'Certified Fresh',
      rtAudienceScore: 91,
      rtAudienceRating: 'Upright',
      rtUrl: 'https://www.rottentomatoes.com/m/example',
      imdbScore: 9.1,
      imdbVotes: 1000,
      imdbUrl: 'https://www.imdb.com/title/tt1234567',
    });
  });
});

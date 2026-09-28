import type { RatingResponse } from '@server/api/ratings';

export interface EffectiveVideoRatings {
  rtCriticsScore?: number;
  rtCriticsRating?: 'Certified Fresh' | 'Fresh' | 'Rotten';
  rtAudienceScore?: number;
  rtAudienceRating?: 'Upright' | 'Spilled';
  rtUrl?: string;
  imdbScore?: number;
  imdbVotes?: number;
  imdbUrl?: string;
}

const finiteScore = (
  value: number | undefined,
  maximum: number
): number | undefined =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= maximum
    ? value
    : undefined;

export const getEffectiveVideoRatings = (
  ratings?: RatingResponse
): EffectiveVideoRatings => {
  const rtCriticsScore =
    finiteScore(ratings?.rt?.criticsScore, 100) ??
    finiteScore(ratings?.mdblist?.rtRating, 100);
  const rtAudienceScore =
    finiteScore(ratings?.rt?.audienceScore, 100) ??
    finiteScore(ratings?.mdblist?.rtUserRating, 100);
  const imdbScore =
    finiteScore(ratings?.imdb?.criticsScore, 10) ??
    finiteScore(ratings?.mdblist?.imdbRating, 10);
  const imdbId = ratings?.mdblist?.imdbId;

  return {
    rtCriticsScore,
    rtCriticsRating:
      ratings?.rt?.criticsRating ??
      (rtCriticsScore === undefined
        ? undefined
        : rtCriticsScore < 60
          ? 'Rotten'
          : 'Fresh'),
    rtAudienceScore,
    rtAudienceRating:
      ratings?.rt?.audienceRating ??
      (rtAudienceScore === undefined
        ? undefined
        : rtAudienceScore < 60
          ? 'Spilled'
          : 'Upright'),
    rtUrl: ratings?.rt?.url,
    imdbScore,
    imdbVotes: ratings?.imdb?.criticsScoreCount ?? ratings?.mdblist?.imdbVotes,
    imdbUrl:
      ratings?.imdb?.url ??
      (imdbId && /^tt\d{1,20}$/.test(imdbId)
        ? `https://www.imdb.com/title/${imdbId}`
        : undefined),
  };
};

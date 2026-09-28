import type { ParsedMdblistRatings } from '@server/api/mdblist';
import { type IMDBRating } from '@server/api/rating/imdbRadarrProxy';
import { type RTRating } from '@server/api/rating/rottentomatoes';

export const MAX_MDBLIST_RATING_BATCH_SIZE = 200;
const MAX_TMDB_ID = 1_000_000_000;

const mdblistScoreFields = [
  'imdbRating',
  'rtRating',
  'rtUserRating',
  'metacriticRating',
  'traktRating',
  'tmdbRating',
] as const;

export const hasMdblistRatingScores = (
  ratings?: ParsedMdblistRatings | null
): ratings is ParsedMdblistRatings =>
  !!ratings &&
  mdblistScoreFields.some((field) => Number.isFinite(ratings[field]));

export const parseMdblistRatingBatchIds = (
  value: unknown
): number[] | undefined => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_MDBLIST_RATING_BATCH_SIZE ||
    value.some(
      (id) =>
        typeof id !== 'number' ||
        !Number.isSafeInteger(id) ||
        id < 1 ||
        id > MAX_TMDB_ID
    )
  ) {
    return undefined;
  }

  return [...new Set(value)];
};

export interface RatingResponse {
  rt?: RTRating;
  imdb?: IMDBRating;
  mdblist?: ParsedMdblistRatings;
}

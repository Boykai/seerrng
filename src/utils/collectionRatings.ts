import type { RatingResponse } from '@server/api/ratings';
import type { MovieDetails } from '@server/models/Movie';
import type { MovieResult } from '@server/models/Search';

export interface CollectionMemberDetails {
  id: number;
  details?: MovieDetails;
  ratings?: RatingResponse;
  failed: boolean;
}

export interface CollectionRating {
  source: 'critics' | 'audience' | 'imdb' | 'tmdb';
  value?: number;
  count: number;
  href?: string;
}

const valid = (value: unknown, max: number): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max;

export const getCollectionMemberRatings = (
  part: Pick<MovieResult, 'id' | 'voteAverage' | 'voteCount'>,
  ratings?: RatingResponse
): CollectionRating[] => [
  {
    source: 'tmdb',
    value:
      part.voteCount > 0 && valid(part.voteAverage, 10)
        ? part.voteAverage * 10
        : undefined,
    count: 0,
    href: `https://www.themoviedb.org/movie/${part.id}`,
  },
  {
    source: 'critics',
    value: valid(ratings?.rt?.criticsScore, 100)
      ? ratings.rt.criticsScore
      : undefined,
    count: 0,
    href: ratings?.rt?.url,
  },
  {
    source: 'audience',
    value: valid(ratings?.rt?.audienceScore, 100)
      ? ratings.rt.audienceScore
      : undefined,
    count: 0,
    href: ratings?.rt?.url,
  },
  {
    source: 'imdb',
    value: valid(ratings?.imdb?.criticsScore, 10)
      ? ratings.imdb.criticsScore
      : undefined,
    count: 0,
    href: ratings?.imdb?.url,
  },
];

export const averageCollectionRatings = (
  parts: Pick<MovieResult, 'id' | 'voteAverage' | 'voteCount'>[],
  members: CollectionMemberDetails[] = []
): CollectionRating[] => {
  const byId = new Map(members.map((member) => [member.id, member]));
  const uniqueParts = [
    ...new Map(parts.map((part) => [part.id, part])).values(),
  ];
  const rows = uniqueParts.map((part) =>
    getCollectionMemberRatings(part, byId.get(part.id)?.ratings)
  );
  return (['critics', 'audience', 'imdb', 'tmdb'] as const).map((source) => {
    const scores = rows.flatMap((row) =>
      row
        .filter(
          (rating) => rating.source === source && rating.value !== undefined
        )
        .map((rating) => rating.value!)
    );
    return {
      source,
      count: scores.length,
      value: scores.length
        ? scores.reduce((sum, score) => sum + score, 0) / scores.length
        : undefined,
    };
  });
};

import type TheMovieDb from '@server/api/themoviedb';
import type { TmdbExternalIdResponse } from '@server/api/themoviedb/interfaces';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import {
  resolveExternalIdentityMatches,
  type ExternalIdentityCandidate,
} from './externalIdentityResolver';

afterEach(() => mock.restoreAll());

const response = (
  movies: number[] = [],
  shows: number[] = []
): TmdbExternalIdResponse =>
  ({
    movie_results: movies.map((id) => ({ id })),
    tv_results: shows.map((id) => ({ id })),
    person_results: [],
  }) as unknown as TmdbExternalIdResponse;

const client = (externalResults: Record<string, TmdbExternalIdResponse>) => {
  const calls: string[] = [];
  const tmdb = {
    getByExternalId: async (lookup: {
      externalId: string | number;
      type: 'imdb' | 'tvdb';
    }) => {
      calls.push(`${lookup.type}:${lookup.externalId}`);
      return (
        externalResults[`${lookup.type}:${lookup.externalId}`] ?? response()
      );
    },
    getMovie: async ({ movieId }: { movieId: number }) => ({ id: movieId }),
    getTvShow: async ({ tvId }: { tvId: number }) => ({ id: tvId }),
  } as TheMovieDb;
  return { tmdb, calls };
};

it('resolves exact IMDb and TVDB matches after confirming their TMDB details', async () => {
  const { tmdb, calls } = client({
    'imdb:tt1234567': response([101]),
    'tvdb:202': response([], [2020]),
  });
  const items: ExternalIdentityCandidate[] = [
    {
      id: 'trakt:movie:1',
      title: 'A movie',
      mediaType: 'movie',
      imdbId: 'tt1234567',
    },
    {
      id: 'plex:tv:show-key',
      title: 'A series',
      mediaType: 'tv',
      tvdbId: 202,
    },
  ];

  const result = await resolveExternalIdentityMatches(items, tmdb);

  assert.deepEqual(
    result.map(({ tmdbId, mediaType, identityResolution }) => ({
      tmdbId,
      mediaType,
      identityResolution,
    })),
    [
      { tmdbId: 101, mediaType: 'movie', identityResolution: 'external-id' },
      { tmdbId: 2020, mediaType: 'tv', identityResolution: 'external-id' },
    ]
  );
  assert.deepEqual(calls.sort(), ['imdb:tt1234567', 'tvdb:202']);
});

it('leaves ambiguous and type-conflicting external IDs in the repair queue', async () => {
  const { tmdb } = client({
    'imdb:tt1234567': response([101, 102]),
    'imdb:tt7654321': response([303]),
    'imdb:tt1111111': response([404], [405]),
    'imdb:tt2222222': response([505], [606]),
  });
  const items: ExternalIdentityCandidate[] = [
    {
      id: 'mdblist:unknown:tt1234567',
      title: 'Ambiguous',
      imdbId: 'tt1234567',
    },
    {
      id: 'trakt:tv:2',
      title: 'Type conflict',
      mediaType: 'tv',
      imdbId: 'tt7654321',
    },
    {
      id: 'mdblist:unknown:tt1111111',
      title: 'Two types',
      imdbId: 'tt1111111',
    },
    {
      id: 'trakt:movie:4',
      title: 'Movie and TV collision',
      mediaType: 'movie',
      imdbId: 'tt2222222',
    },
  ];

  const result = await resolveExternalIdentityMatches(items, tmdb);

  assert.deepEqual(result, items);
});

it('preserves private or existing matches and tolerates catalog failures', async () => {
  let calls = 0;
  const tmdb = {
    getByExternalId: async () => {
      calls += 1;
      throw new Error('TMDB unavailable');
    },
    getMovie: async () => ({ id: 1 }),
    getTvShow: async () => ({ id: 1 }),
  } as unknown as TheMovieDb;
  const items: ExternalIdentityCandidate[] = [
    {
      id: 'trakt:movie:1',
      title: 'Private match',
      tmdbId: 100,
      mediaType: 'movie',
      identityMapped: true,
      identityResolution: 'personal',
      imdbId: 'tt1234567',
    },
    {
      id: 'trakt:movie:2',
      title: 'Catalog ID',
      tmdbId: 200,
      mediaType: 'movie',
      imdbId: 'tt7654321',
    },
    {
      id: 'trakt:movie:3',
      title: 'Unavailable',
      imdbId: 'tt1111111',
    },
  ];

  const result = await resolveExternalIdentityMatches(items, tmdb);

  assert.deepEqual(result.slice(0, 2), items.slice(0, 2));
  assert.deepEqual(result[2], items[2]);
  assert.equal(calls, 1);
});

it('keeps concurrent TMDB lookups bounded to four titles', async () => {
  let active = 0;
  let maximumActive = 0;
  const tmdb = {
    getByExternalId: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return response();
    },
    getMovie: async () => ({ id: 1 }),
    getTvShow: async () => ({ id: 1 }),
  } as unknown as TheMovieDb;
  const items: ExternalIdentityCandidate[] = Array.from(
    { length: 11 },
    (_, index) => ({
      id: `trakt:movie:${index + 1}`,
      title: `Title ${index + 1}`,
      mediaType: 'movie',
      imdbId: `tt${String(index + 1).padStart(7, '0')}`,
    })
  );

  await resolveExternalIdentityMatches(items, tmdb);

  assert.equal(maximumActive, 4);
});

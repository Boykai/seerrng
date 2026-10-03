import type { TmdbMovieResult } from '@server/api/themoviedb/interfaces';
import { resetTestDb, seedTestDb } from '@server/utils/seedTestDb';
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  decodeDiscoverMovieFeedPage,
  getCachedDiscoverMovieFeed,
  getDiscoverMovieFeedCacheKey,
  getMovieFeedShelf,
  saveDiscoverMovieFeed,
} from './discoverMovieFeedCache';

const movie: TmdbMovieResult = {
  id: 501,
  media_type: 'movie',
  title: 'Cached Feature',
  original_title: 'Cached Feature',
  release_date: '2026-10-02',
  popularity: 10,
  poster_path: '/cached-feature.jpg',
  backdrop_path: '/cached-feature-backdrop.jpg',
  vote_count: 25,
  vote_average: 7.5,
  genre_ids: [18],
  overview: 'Saved movie feed data.',
  original_language: 'en',
  adult: false,
  video: false,
};

describe('movie discovery feed cache', () => {
  before(async () => {
    await seedTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
  });

  afterEach(async () => {
    await resetTestDb();
  });

  it('caches only the built-in popular and upcoming shelves', () => {
    assert.equal(getMovieFeedShelf({}), 'popular');
    assert.equal(
      getMovieFeedShelf({ primaryReleaseDateGte: '2026-10-03' }),
      'upcoming'
    );
    assert.equal(getMovieFeedShelf({ search: 'Arrival' }), undefined);
    assert.equal(getMovieFeedShelf({ genre: '18' }), undefined);
    assert.equal(getMovieFeedShelf({ sortBy: 'popularity.desc' }), undefined);
    assert.equal(
      getMovieFeedShelf({ primaryReleaseDateLte: '2026-10-03' }),
      undefined
    );
  });

  it('separates snapshots by page, locale, region, and original language', () => {
    const base = {
      shelf: 'popular' as const,
      page: 1,
      language: 'en-US',
      region: 'CA',
      originalLanguage: 'en',
      includeAdult: false,
    };
    const key = getDiscoverMovieFeedCacheKey(base);

    assert.match(key, /^[a-f0-9]{64}$/);
    assert.notEqual(
      key,
      getDiscoverMovieFeedCacheKey({ ...base, region: 'US' })
    );
    assert.notEqual(key, getDiscoverMovieFeedCacheKey({ ...base, page: 2 }));
  });

  it('keeps a successful feed snapshot in the database for provider outages', async () => {
    const cacheKey = getDiscoverMovieFeedCacheKey({
      shelf: 'popular',
      page: 1,
      language: 'en-US',
      region: 'CA',
      originalLanguage: 'en',
      includeAdult: false,
    });
    const fetchedAt = new Date('2026-10-02T12:00:00.000Z');
    const page = {
      page: 1,
      totalPages: 2,
      totalResults: 25,
      results: [movie],
    };

    await saveDiscoverMovieFeed(cacheKey, page, fetchedAt);

    assert.deepEqual(await getCachedDiscoverMovieFeed(cacheKey), {
      fetchedAt,
      page,
    });
  });

  it('rejects malformed persisted feed payloads', () => {
    assert.equal(
      decodeDiscoverMovieFeedPage({ results: [{ id: 1 }] }),
      undefined
    );
  });
});

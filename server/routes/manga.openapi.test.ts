import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import AnilistAPI from '@server/api/anilist';
import { AnilistRateLimitedError } from '@server/api/anilist/failures';
import type {
  AnilistMangaDetails,
  AnilistMangaSummary,
} from '@server/api/anilist/manga';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';
import mangaRoutes, { mangaDiscoverRoutes } from './manga';

const summary: AnilistMangaSummary = {
  id: 30013,
  idMal: 13,
  titles: {
    romaji: 'Sample Romaji',
    english: 'Sample Manga',
    native: 'Native',
  },
  synonyms: ['Sample Synonym'],
  format: 'MANGA',
  status: 'RELEASING',
  chapters: 100,
  volumes: 10,
  isAdult: false,
  coverImage:
    'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/sample.jpg',
  bannerImage:
    'https://s4.anilist.co/file/anilistcdn/media/manga/banner/sample.jpg',
  genres: ['Adventure'],
  startYear: 1997,
  countryOfOrigin: 'JP',
  averageScore: 88,
};

const details: AnilistMangaDetails = {
  ...summary,
  description: '<p>A sample story.</p>',
  tags: [{ name: 'Pirates', rank: 90, isSpoiler: false, isAdult: false }],
  staff: [{ id: 1, name: 'Sample Author', role: 'Story & Art' }],
  siteUrl: 'https://anilist.co/manga/30013',
  startDate: '1997-07-22',
  endDate: '2020-01',
};

// Validates requests and responses against the published contract, so the
// spec and the routes cannot drift apart. Error responses follow the spec's
// convention of documenting a description only, so their bodies are checked
// with response validation off.
function createApp({ validateResponses = true } = {}) {
  const app = express();
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateResponses,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/discover/manga', mangaDiscoverRoutes);
  app.use('/api/v1/manga', mangaRoutes);
  app.get('/api/v1/search', (req, res) =>
    res.status(200).json({
      page: 1,
      totalPages: 1,
      totalResults: 0,
      results: [],
      type: req.query.type,
    })
  );
  app.use(
    (
      error: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) =>
      res.status(error.status ?? 500).json({
        status: error.status ?? 500,
        message: error.message,
      })
  );
  return app;
}

let originalCacheImages: boolean;

beforeEach(() => {
  originalCacheImages = getSettings().main.cacheImages;
  // Keep image warming from reaching the AniList CDN.
  getSettings().main.cacheImages = false;
});

afterEach(() => {
  mock.restoreAll();
  getSettings().main.cacheImages = originalCacheImages;
});

setupTestDb();

describe('manga catalog through the OpenAPI contract', () => {
  it('admits every documented discovery filter and returns documented results', async () => {
    const getPage = mock.method(
      AnilistAPI.prototype,
      'getMangaPage',
      async () => ({
        pageInfo: { total: 1, currentPage: 2, lastPage: 2, hasNextPage: false },
        media: [summary],
      })
    );

    const res = await request(createApp()).get('/api/v1/discover/manga').query({
      page: 2,
      query: 'sample',
      sortBy: 'top_rated',
      genre: 'Drama',
      format: 'MANGA',
      status: 'RELEASING',
      countryOfOrigin: 'KR',
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(getPage.mock.callCount(), 1);
    assert.strictEqual(res.body.results[0]?.id, 30013);
  });

  it('rejects values outside the documented discovery filters', async () => {
    const getPage = mock.method(AnilistAPI.prototype, 'getMangaPage');
    const app = createApp();

    for (const query of [
      { sortBy: 'newest' },
      { format: 'MUSIC' },
      { status: 'PAUSED' },
      { countryOfOrigin: 'US' },
      { page: 0 },
      { page: 501 },
      { genre: 'g'.repeat(65) },
      { query: 'q'.repeat(257) },
    ]) {
      const res = await request(app).get('/api/v1/discover/manga').query(query);
      assert.strictEqual(res.status, 400, JSON.stringify(query));
    }
    assert.strictEqual(getPage.mock.callCount(), 0);
  });

  it('returns documented manga details', async () => {
    mock.method(AnilistAPI.prototype, 'getMangaDetails', async () => details);

    const res = await request(createApp()).get('/api/v1/manga/30013');

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.title, 'Sample Manga');
    assert.deepStrictEqual(res.body.story, [{ id: 1, name: 'Sample Author' }]);
  });

  it('admits detail requests that end in an AniList rate limit', async () => {
    mock.method(AnilistAPI.prototype, 'getMangaDetails', async () => {
      throw new AnilistRateLimitedError(45);
    });

    const res = await request(createApp({ validateResponses: false })).get(
      '/api/v1/manga/30013'
    );

    assert.strictEqual(res.status, 429, JSON.stringify(res.body));
    assert.strictEqual(res.headers['retry-after'], '45');
    assert.strictEqual(
      res.body.message,
      'AniList rate limit reached. Try again later.'
    );
  });

  it('rejects manga ids that are not positive integers', async () => {
    const getDetails = mock.method(AnilistAPI.prototype, 'getMangaDetails');
    const app = createApp();

    for (const id of ['0', 'abc', '-3']) {
      const res = await request(app).get(`/api/v1/manga/${id}`);
      assert.strictEqual(res.status, 400, id);
    }
    assert.strictEqual(getDetails.mock.callCount(), 0);
  });

  it('admits manga as a search type', async () => {
    const res = await request(createApp())
      .get('/api/v1/search')
      .query({ query: 'sample', type: 'manga' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.type, 'manga');
  });
});

describe('manga discover filters through the OpenAPI contract', () => {
  const newSorts = [
    'popular.asc',
    'top_rated.asc',
    'start_date.desc',
    'start_date.asc',
    'title.asc',
    'title.desc',
  ];

  it('admits every AniList filter and sort', async () => {
    const getPage = mock.method(
      AnilistAPI.prototype,
      'getMangaPage',
      async () => ({
        pageInfo: { total: 1, currentPage: 1, lastPage: 1, hasNextPage: false },
        media: [summary],
      })
    );
    const app = createApp();

    const res = await request(app).get('/api/v1/discover/manga').query({
      genre: 'Drama',
      genres: 'Action,Comedy',
      excludeGenres: 'Horror',
      tags: 'Pirates',
      excludeTags: 'Time Skip,Isekai',
      source: 'LIGHT_NOVEL',
      minStartYear: 1990,
      maxStartYear: 2005,
      minScore: 0,
      maxScore: 100,
      minChapters: 1,
      maxChapters: 100_000,
      minVolumes: 0,
      maxVolumes: 3,
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const options = getPage.mock.calls[0]?.arguments[0];
    assert.deepStrictEqual(options?.excludedTags, ['Time Skip', 'Isekai']);
    assert.deepStrictEqual(options?.startYear, { min: 1990, max: 2005 });
    assert.deepStrictEqual(options?.averageScore, { min: 0, max: 100 });
    assert.deepStrictEqual(options?.chapters, { min: 1, max: 100_000 });
    assert.deepStrictEqual(options?.volumes, { min: 0, max: 3 });

    for (const sortBy of newSorts) {
      const sorted = await request(app)
        .get('/api/v1/discover/manga')
        .query({ sortBy });
      assert.strictEqual(sorted.status, 200, sortBy);
    }
    assert.strictEqual(getPage.mock.callCount(), 1 + newSorts.length);
  });

  it('rejects values outside the documented AniList filters', async () => {
    const getPage = mock.method(AnilistAPI.prototype, 'getMangaPage');
    const app = createApp();

    for (const query of [
      { genres: Array.from({ length: 11 }, (_, i) => `G${i}`).join(',') },
      { tags: 't'.repeat(65) },
      { excludeTags: 'Pirates,,Isekai' },
      { excludeGenres: ',Horror' },
      { source: 'BOOK' },
      { minScore: 101 },
      { maxScore: 'high' },
      { minStartYear: 1799 },
      { maxStartYear: 2201 },
      { minChapters: -1 },
      { maxVolumes: 100_001 },
      { sortBy: 'newest' },
      { sortBy: 'trending.asc' },
    ]) {
      const res = await request(app).get('/api/v1/discover/manga').query(query);
      assert.strictEqual(res.status, 400, JSON.stringify(query));
      // The contract itself refuses the value, before the route reads it.
      assert.match(res.body.message, /request\/query\//, JSON.stringify(query));
    }
    assert.strictEqual(getPage.mock.callCount(), 0);
  });

  it('returns documented filter names', async () => {
    mock.method(AnilistAPI.prototype, 'getMangaFilterOptions', async () => ({
      genres: [{ name: 'Drama', isAdult: false }],
      tags: [{ name: 'Pirates', isAdult: false }],
    }));

    const res = await request(createApp()).get(
      '/api/v1/discover/manga/filters'
    );

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, {
      genres: ['Drama'],
      tags: ['Pirates'],
      formats: ['MANGA', 'ONE_SHOT'],
    });
  });

  it('admits filter name requests that end in an AniList rate limit', async () => {
    mock.method(AnilistAPI.prototype, 'getMangaFilterOptions', async () => {
      throw new AnilistRateLimitedError(45);
    });

    const res = await request(createApp({ validateResponses: false })).get(
      '/api/v1/discover/manga/filters'
    );

    assert.strictEqual(res.status, 429, JSON.stringify(res.body));
    assert.strictEqual(res.headers['retry-after'], '45');
  });
});

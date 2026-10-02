import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import AnilistAPI from '@server/api/anilist';
import {
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist/failures';
import type {
  AnilistMangaDetails,
  AnilistMangaPage,
  AnilistMangaPageOptions,
  AnilistMangaSummary,
} from '@server/api/anilist/manga';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import router from './index';

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    // Test-only session middleware has no network listener or real secret.
    // codeql[js/clear-text-cookie]
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use('/api/v1', router);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

const summary = (
  overrides: Partial<AnilistMangaSummary> = {}
): AnilistMangaSummary => ({
  id: 30013,
  titles: { romaji: 'Sample Romaji', english: 'Sample Manga' },
  synonyms: [],
  format: 'MANGA',
  status: 'RELEASING',
  isAdult: false,
  coverImage:
    'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/sample.jpg',
  genres: ['Adventure'],
  countryOfOrigin: 'JP',
  averageScore: 88,
  ...overrides,
});

const details = (
  overrides: Partial<AnilistMangaDetails> = {}
): AnilistMangaDetails => ({
  ...summary(),
  description: '<p>A sample story.</p>',
  tags: [
    { name: 'Pirates', rank: 90, isSpoiler: false, isAdult: false },
    { name: 'Late Twist', rank: 70, isSpoiler: true, isAdult: false },
  ],
  staff: [
    { id: 1, name: 'Sample Author', role: 'Story & Art' },
    { id: 2, name: 'Sample Editor', role: 'Editing' },
  ],
  siteUrl: 'https://anilist.co/manga/30013',
  startDate: '1997-07-22',
  ...overrides,
});

const page = (overrides: Partial<AnilistMangaPage> = {}): AnilistMangaPage => ({
  pageInfo: { total: 1, currentPage: 1, lastPage: 1, hasNextPage: false },
  media: [summary()],
  ...overrides,
});

const trackManga = async (anilistId: number) => {
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: 0,
      mediaType: MediaType.MANGA,
      status: MediaStatus.AVAILABLE,
    })
  );
  await getRepository(MediaIdentifier).save(
    new MediaIdentifier({
      media,
      provider: MediaIdentifierProvider.ANILIST,
      value: String(anilistId),
      canonical: true,
    })
  );
  return media;
};

async function loginAs(email: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/v1/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

let originalMain: {
  categories: ReturnType<typeof getSettings>['main']['enabledMediaCategories'];
  cacheImages: boolean;
  mangaIncludeAdult: boolean;
  mangaIncludeNovels: boolean;
};

before(() => {
  app = createApp();
});

beforeEach(() => {
  const { main } = getSettings();
  originalMain = {
    categories: { ...main.enabledMediaCategories },
    cacheImages: main.cacheImages,
    mangaIncludeAdult: main.mangaIncludeAdult,
    mangaIncludeNovels: main.mangaIncludeNovels,
  };
  main.enabledMediaCategories = { ...main.enabledMediaCategories, manga: true };
  // Keep image warming from reaching the AniList CDN.
  main.cacheImages = false;
  main.mangaIncludeAdult = false;
  main.mangaIncludeNovels = false;
});

afterEach(() => {
  mock.restoreAll();
  const { main } = getSettings();
  main.enabledMediaCategories = originalMain.categories;
  main.cacheImages = originalMain.cacheImages;
  main.mangaIncludeAdult = originalMain.mangaIncludeAdult;
  main.mangaIncludeNovels = originalMain.mangaIncludeNovels;
});

setupTestDb();

describe('manga route access', () => {
  it('answers like unknown routes while manga is disabled, without calling AniList', async () => {
    getSettings().main.enabledMediaCategories = {
      ...getSettings().main.enabledMediaCategories,
      manga: false,
    };
    const getDetails = mock.method(AnilistAPI.prototype, 'getMangaDetails');
    const getPage = mock.method(AnilistAPI.prototype, 'getMangaPage');
    const agent = await loginAs('friend@seerr.dev');

    for (const path of [
      '/api/v1/manga/30013',
      '/api/v1/discover/manga',
      '/api/v1/discover/manga/anything',
    ]) {
      const res = await agent.get(path);
      assert.strictEqual(res.status, 404, path);
      assert.deepStrictEqual(
        res.body,
        { status: 404, message: 'Not found.' },
        path
      );
    }
    assert.strictEqual(getDetails.mock.callCount(), 0);
    assert.strictEqual(getPage.mock.callCount(), 0);
  });

  it('requires a signed-in user', async () => {
    const getDetails = mock.method(AnilistAPI.prototype, 'getMangaDetails');

    const res = await request(app).get('/api/v1/manga/30013');

    assert.strictEqual(res.status, 403);
    assert.strictEqual(getDetails.mock.callCount(), 0);
  });
});

describe('GET /manga/:id', () => {
  it('returns AniList details merged with local media state', async () => {
    const media = await trackManga(30013);
    const getDetails = mock.method(
      AnilistAPI.prototype,
      'getMangaDetails',
      async () => details()
    );
    const agent = await loginAs('friend@seerr.dev');

    const res = await agent.get('/api/v1/manga/30013');

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(getDetails.mock.calls[0]?.arguments, [30013]);
    assert.strictEqual(res.body.id, 30013);
    assert.strictEqual(res.body.mediaType, 'manga');
    assert.strictEqual(res.body.provider, 'anilist');
    assert.strictEqual(res.body.title, 'Sample Manga');
    assert.strictEqual(res.body.description, '<p>A sample story.</p>');
    assert.deepStrictEqual(res.body.tags, [{ name: 'Pirates', rank: 90 }]);
    assert.deepStrictEqual(res.body.story, [{ id: 1, name: 'Sample Author' }]);
    assert.deepStrictEqual(res.body.art, [{ id: 1, name: 'Sample Author' }]);
    assert.strictEqual(res.body.siteUrl, 'https://anilist.co/manga/30013');
    assert.strictEqual(res.body.mediaInfo?.id, media.id);
    assert.strictEqual(res.body.mediaInfo?.status, MediaStatus.AVAILABLE);
  });

  it('answers excluded titles like unknown ids until an administrator includes them', async () => {
    let current: AnilistMangaDetails | null = details({ isAdult: true });
    mock.method(AnilistAPI.prototype, 'getMangaDetails', async () => current);
    const agent = await loginAs('friend@seerr.dev');
    const notFound = { status: 404, message: 'Manga not found.' };

    let res = await agent.get('/api/v1/manga/30013');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.body, notFound);

    getSettings().main.mangaIncludeAdult = true;
    res = await agent.get('/api/v1/manga/30013');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isAdult, true);

    current = details({ format: 'NOVEL' });
    res = await agent.get('/api/v1/manga/30013');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.body, notFound);

    getSettings().main.mangaIncludeNovels = true;
    res = await agent.get('/api/v1/manga/30013');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.format, 'NOVEL');

    current = null;
    res = await agent.get('/api/v1/manga/30013');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.body, notFound);
  });

  it('rejects malformed manga ids without calling AniList', async () => {
    const getDetails = mock.method(AnilistAPI.prototype, 'getMangaDetails');
    const agent = await loginAs('friend@seerr.dev');

    for (const id of ['abc', '0', '-1', '1.5', '1000000001']) {
      const res = await agent.get(`/api/v1/manga/${id}`);
      assert.strictEqual(res.status, 400, id);
      assert.deepStrictEqual(
        res.body,
        { status: 400, message: 'Manga id must be a positive integer.' },
        id
      );
    }
    assert.strictEqual(getDetails.mock.callCount(), 0);
  });

  it('reports AniList rate limits with a bounded Retry-After', async () => {
    let retryAfter = 120;
    mock.method(AnilistAPI.prototype, 'getMangaDetails', async () => {
      throw new AnilistRateLimitedError(retryAfter);
    });
    const agent = await loginAs('friend@seerr.dev');

    let res = await agent.get('/api/v1/manga/30013');
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.headers['retry-after'], '120');
    assert.deepStrictEqual(res.body, {
      status: 429,
      message: 'AniList rate limit reached. Try again later.',
    });

    retryAfter = 99_999;
    res = await agent.get('/api/v1/manga/30013');
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.headers['retry-after'], '3600');
  });

  it('reports other AniList failures as unavailable', async () => {
    mock.method(AnilistAPI.prototype, 'getMangaDetails', async () => {
      throw new AnilistOutageError();
    });
    const agent = await loginAs('friend@seerr.dev');

    const res = await agent.get('/api/v1/manga/30013');

    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers['retry-after'], undefined);
    assert.deepStrictEqual(res.body, {
      status: 503,
      message: 'Unable to retrieve manga details.',
    });
  });
});

describe('GET /discover/manga', () => {
  const discover = async (query: Record<string, string> = {}) => {
    const agent = await loginAs('friend@seerr.dev');
    return agent.get('/api/v1/discover/manga').query(query);
  };

  it('validates filters before calling AniList', async () => {
    const getPage = mock.method(AnilistAPI.prototype, 'getMangaPage');
    const agent = await loginAs('friend@seerr.dev');

    for (const [query, message] of [
      [{ sortBy: 'newest' }, 'sortBy must be valid.'],
      [{ format: 'MUSIC' }, 'format must be valid.'],
      [{ status: 'PAUSED' }, 'status must be valid.'],
      [{ countryOfOrigin: 'US' }, 'countryOfOrigin must be valid.'],
      [{ genre: 'g'.repeat(65) }, 'Genre must be 64 characters or fewer.'],
      [{ query: 'q'.repeat(257) }, 'Query must be 256 characters or fewer.'],
    ] as const) {
      const res = await agent.get('/api/v1/discover/manga').query(query);
      assert.strictEqual(res.status, 400, JSON.stringify(query));
      assert.deepStrictEqual(res.body, { status: 400, message });
    }
    assert.strictEqual(getPage.mock.callCount(), 0);
  });

  it('sorts by trending by default and by best match for a query', async () => {
    const calls: AnilistMangaPageOptions[] = [];
    mock.method(
      AnilistAPI.prototype,
      'getMangaPage',
      async (options: AnilistMangaPageOptions) => {
        calls.push(options);
        return page({ media: [] });
      }
    );
    const agent = await loginAs('friend@seerr.dev');

    for (const query of [
      {},
      { query: 'sample' },
      { sortBy: 'popular' },
      { sortBy: 'top_rated', query: 'sample' },
      { sortBy: 'trending', query: '   ' },
    ]) {
      const res = await agent.get('/api/v1/discover/manga').query(query);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    }

    assert.deepStrictEqual(
      calls.map(({ sort, search }) => ({ sort, search })),
      [
        { sort: ['TRENDING_DESC', 'POPULARITY_DESC'], search: undefined },
        { sort: ['SEARCH_MATCH'], search: 'sample' },
        { sort: ['POPULARITY_DESC'], search: undefined },
        { sort: ['SCORE_DESC'], search: 'sample' },
        { sort: ['TRENDING_DESC', 'POPULARITY_DESC'], search: undefined },
      ]
    );
  });

  it('passes filters and the content policy to AniList', async () => {
    const getPage = mock.method(
      AnilistAPI.prototype,
      'getMangaPage',
      async () => page({ media: [] })
    );
    getSettings().main.mangaIncludeAdult = true;

    const res = await discover({
      page: '3',
      genre: 'Drama',
      format: 'ONE_SHOT',
      status: 'FINISHED',
      countryOfOrigin: 'KR',
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(getPage.mock.calls[0]?.arguments, [
      {
        page: 3,
        sort: ['TRENDING_DESC', 'POPULARITY_DESC'],
        search: undefined,
        genre: 'Drama',
        format: 'ONE_SHOT',
        status: 'FINISHED',
        countryOfOrigin: 'KR',
        includeAdult: true,
        includeNovels: false,
      },
    ]);
  });

  it('returns no light novels until an administrator includes them', async () => {
    const getPage = mock.method(
      AnilistAPI.prototype,
      'getMangaPage',
      async () => page({ media: [summary({ format: 'NOVEL' })] })
    );

    let res = await discover({ format: 'NOVEL', page: '2' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 2,
      totalPages: 1,
      totalResults: 0,
      results: [],
    });
    assert.strictEqual(getPage.mock.callCount(), 0);

    getSettings().main.mangaIncludeNovels = true;
    res = await discover({ format: 'NOVEL' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(getPage.mock.callCount(), 1);
    assert.strictEqual(getPage.mock.calls[0]?.arguments[0]?.format, 'NOVEL');
    assert.strictEqual(
      getPage.mock.calls[0]?.arguments[0]?.includeNovels,
      true
    );
    assert.strictEqual(res.body.results[0]?.format, 'NOVEL');
  });

  it('maps results with local media state and page totals', async () => {
    const media = await trackManga(30013);
    mock.method(AnilistAPI.prototype, 'getMangaPage', async () =>
      page({
        pageInfo: { total: 41, currentPage: 1, lastPage: 3, hasNextPage: true },
        media: [summary(), summary({ id: 2, titles: { romaji: 'Second' } })],
      })
    );

    const res = await discover();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.page, 1);
    assert.strictEqual(res.body.totalPages, 3);
    assert.strictEqual(res.body.totalResults, 41);
    assert.deepStrictEqual(
      res.body.results.map(
        (result: { id: number; mediaType: string; title: string }) => ({
          id: result.id,
          mediaType: result.mediaType,
          title: result.title,
        })
      ),
      [
        { id: 30013, mediaType: 'manga', title: 'Sample Manga' },
        { id: 2, mediaType: 'manga', title: 'Second' },
      ]
    );
    assert.strictEqual(res.body.results[0].mediaInfo?.id, media.id);
    assert.strictEqual(res.body.results[1].mediaInfo, undefined);
  });

  it('bounds page totals to the pages AniList can serve', async () => {
    let response = page({
      pageInfo: { total: 999_999, lastPage: 50_000, hasNextPage: true },
    });
    mock.method(AnilistAPI.prototype, 'getMangaPage', async () => response);

    let res = await discover();
    assert.strictEqual(res.body.totalPages, 500);
    assert.strictEqual(res.body.totalResults, 999_999);

    response = page({ pageInfo: { hasNextPage: true } });
    res = await discover({ page: '4' });
    assert.strictEqual(res.body.page, 4);
    assert.strictEqual(res.body.totalPages, 5);
    assert.strictEqual(res.body.totalResults, 1);

    response = page({ pageInfo: { hasNextPage: false } });
    res = await discover({ page: '2' });
    assert.strictEqual(res.body.totalPages, 2);

    res = await discover({ page: '9000' });
    assert.strictEqual(res.body.page, 500);
  });

  it('reports AniList rate limits and outages', async () => {
    let failure: Error = new AnilistRateLimitedError(30);
    mock.method(AnilistAPI.prototype, 'getMangaPage', async () => {
      throw failure;
    });

    let res = await discover();
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.headers['retry-after'], '30');
    assert.deepStrictEqual(res.body, {
      status: 429,
      message: 'AniList rate limit reached. Try again later.',
    });

    failure = new AnilistOutageError();
    res = await discover();
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.body, {
      status: 503,
      message:
        'AniList, the service used for manga discovery, timed out or is unavailable. Please try again.',
    });

    failure = new Error('socket hang up');
    res = await discover();
    assert.strictEqual(res.status, 503);
  });
});

import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import AnilistAPI from '@server/api/anilist';
import {
  AnilistGraphQLError,
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist/failures';
import type {
  AnilistMangaDetails,
  AnilistMangaPage,
  AnilistMangaPageOptions,
  AnilistMangaSummary,
} from '@server/api/anilist/manga';
import { resetAnilistRateLimiterForTests } from '@server/api/anilist/rateLimiter';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import type { AxiosResponse } from 'axios';
import axios, { AxiosError } from 'axios';
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

  it('marks titles blocklisted through the blocklist on discover and details', async () => {
    await Blocklist.addToBlocklist({
      blocklistRequest: {
        mediaType: MediaType.MANGA,
        externalId: '030013',
        title: 'Sample Manga',
      },
    });
    mock.method(AnilistAPI.prototype, 'getMangaPage', async () =>
      page({ media: [summary(), summary({ id: 2 })] })
    );
    mock.method(AnilistAPI.prototype, 'getMangaDetails', async () => details());

    const res = await discover();
    const detail = await (
      await loginAs('friend@seerr.dev')
    ).get('/api/v1/manga/30013');

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(
      res.body.results[0].mediaInfo?.status,
      MediaStatus.BLOCKLISTED
    );
    assert.strictEqual(res.body.results[1].mediaInfo, undefined);
    assert.strictEqual(detail.status, 200, JSON.stringify(detail.body));
    assert.strictEqual(detail.body.mediaInfo?.status, MediaStatus.BLOCKLISTED);
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

describe('AniList filters on GET /discover/manga', () => {
  type AnilistBody = { query: string; variables: Record<string, unknown> };
  const unavailable = {
    status: 503,
    message:
      'AniList, the service used for manga discovery, timed out or is unavailable. Please try again.',
  };
  const anilistManga = (overrides: Record<string, unknown> = {}) => ({
    id: 30013,
    title: { romaji: 'Sample Romaji', english: 'Sample Manga' },
    format: 'MANGA',
    status: 'RELEASING',
    isAdult: false,
    ...overrides,
  });
  const anilistPage = (media: unknown[]) => ({
    data: {
      Page: {
        pageInfo: { total: media.length, lastPage: 1, hasNextPage: false },
        media,
      },
    },
  });
  const catalog = {
    data: {
      GenreCollection: ['Drama', 'Action', 'Hentai'],
      MediaTagCollection: [
        { name: 'Pirates', isAdult: false },
        { name: 'Example Adult Tag', isAdult: true },
      ],
    },
  };

  let previousAdapter: typeof axios.defaults.adapter;
  let anilistUrls: string[];

  // Answers every AniList request the routes make, so a test can count them.
  const stubAnilistNetwork = (
    respond: (body: AnilistBody) => { status?: number; data: unknown }
  ): AnilistBody[] => {
    const bodies: AnilistBody[] = [];
    axios.defaults.adapter = async (config) => {
      anilistUrls.push(String(config.url));
      const body = JSON.parse(String(config.data)) as AnilistBody;
      bodies.push(body);
      const { status = 200, data } = respond(body);
      const response = {
        data,
        status,
        statusText: String(status),
        headers: {},
        config,
      } as AxiosResponse;
      if (status >= 400) {
        throw new AxiosError(
          `Request failed with status code ${status}`,
          AxiosError.ERR_BAD_REQUEST,
          config,
          undefined,
          response
        );
      }
      return response;
    };
    return bodies;
  };

  beforeEach(() => {
    previousAdapter = axios.defaults.adapter;
    anilistUrls = [];
    let now = 1_000_000;
    resetAnilistRateLimiterForTests({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    cacheManager.getCache('anilist').flush();
  });

  afterEach(() => {
    axios.defaults.adapter = previousAdapter;
    for (const url of anilistUrls) {
      assert.match(url, /^https:\/\/graphql\.anilist\.co\/?$/);
    }
    cacheManager.getCache('anilist').flush();
    resetAnilistRateLimiterForTests();
  });

  it('validates the AniList filters before calling AniList', async () => {
    const getPage = mock.method(AnilistAPI.prototype, 'getMangaPage');
    const agent = await loginAs('friend@seerr.dev');
    const elevenGenres = Array.from({ length: 11 }, (_, i) => `Genre ${i}`);

    for (const [query, message] of [
      [
        { genres: elevenGenres.join(',') },
        'genres must list 1 to 10 names of up to 64 characters, separated by commas.',
      ],
      [
        { excludeTags: 'Pirates,,Isekai' },
        'excludeTags must list 1 to 10 names of up to 64 characters, separated by commas.',
      ],
      [{ source: 'BOOK' }, 'source must be valid.'],
      [{ minScore: '101' }, 'minScore must be a whole number from 0 to 100.'],
      [
        { minStartYear: '1799' },
        'minStartYear must be a whole number from 1800 to 2200.',
      ],
      [
        { minChapters: '20', maxChapters: '10' },
        'minChapters must not be greater than maxChapters.',
      ],
      [
        { genre: 'Drama', excludeGenres: 'Drama' },
        'genres and excludeGenres must not share a name.',
      ],
      [
        { tags: 'Pirates', excludeTags: 'Pirates' },
        'tags and excludeTags must not share a name.',
      ],
    ] as const) {
      const res = await agent.get('/api/v1/discover/manga').query(query);
      assert.strictEqual(res.status, 400, JSON.stringify(query));
      assert.deepStrictEqual(res.body, { status: 400, message });
    }
    assert.strictEqual(getPage.mock.callCount(), 0);
  });

  it('passes the AniList filters and every sort to AniList', async () => {
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

    let res = await agent.get('/api/v1/discover/manga').query({
      sortBy: 'start_date.desc',
      genres: 'Action,Comedy',
      excludeGenres: 'Horror',
      tags: 'Pirates',
      excludeTags: 'Time Skip',
      source: 'WEB_NOVEL',
      minStartYear: '1990',
      maxStartYear: '2005',
      minScore: '70',
      maxChapters: '200',
      minVolumes: '2',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(calls[0], {
      page: 1,
      sort: ['START_DATE_DESC', 'ID_DESC'],
      search: undefined,
      genre: undefined,
      format: undefined,
      status: undefined,
      countryOfOrigin: undefined,
      genres: ['Action', 'Comedy'],
      excludedGenres: ['Horror'],
      tags: ['Pirates'],
      excludedTags: ['Time Skip'],
      source: 'WEB_NOVEL',
      startYear: { min: 1990, max: 2005 },
      averageScore: { min: 70 },
      chapters: { max: 200 },
      volumes: { min: 2 },
      includeAdult: false,
      includeNovels: false,
    });

    const sorts = [
      ['popular.asc', ['POPULARITY', 'ID']],
      ['top_rated.asc', ['SCORE', 'ID']],
      ['start_date.asc', ['START_DATE', 'ID']],
      ['title.asc', ['TITLE_ROMAJI', 'ID']],
      ['title.desc', ['TITLE_ROMAJI_DESC', 'ID_DESC']],
    ] as const;
    for (const [sortBy] of sorts) {
      res = await agent.get('/api/v1/discover/manga').query({ sortBy });
      assert.strictEqual(res.status, 200, sortBy);
    }
    assert.deepStrictEqual(
      calls.slice(1).map(({ sort }) => sort),
      sorts.map(([, sort]) => sort)
    );
  });

  it('makes one AniList request per filtered page and keeps the content policy', async () => {
    const bodies = stubAnilistNetwork(() => ({
      data: anilistPage([
        anilistManga(),
        anilistManga({ id: 2, isAdult: true }),
        anilistManga({ id: 3, format: 'NOVEL' }),
      ]),
    }));
    const agent = await loginAs('friend@seerr.dev');

    const res = await agent.get('/api/v1/discover/manga').query({
      genres: 'Hentai',
      format: 'MANGA',
      tags: 'Example Adult Tag',
      minScore: '60',
      sortBy: 'title.asc',
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(bodies.length, 1);
    assert.strictEqual(bodies[0].variables.isAdult, false);
    assert.deepStrictEqual(bodies[0].variables.formatNotIn, ['NOVEL']);
    assert.deepStrictEqual(bodies[0].variables.genreIn, ['Hentai']);
    assert.strictEqual(bodies[0].variables.averageScoreGreater, 59);
    assert.deepStrictEqual(
      res.body.results.map((result: { id: number }) => result.id),
      [30013]
    );
  });

  it('answers fixed text and caches nothing when AniList rejects a filter', async () => {
    const message = 'Example rejection of Unknown Example Tag';
    let reply: { status?: number; data: unknown } = {
      data: { data: null, errors: [{ message, status: 400 }] },
    };
    const bodies = stubAnilistNetwork(() => reply);
    const agent = await loginAs('friend@seerr.dev');
    const query = { tags: 'Unknown Example Tag', minVolumes: '7' };

    for (const rejection of [
      { data: { data: null, errors: [{ message, status: 400 }] } },
      { status: 400, data: { data: null, errors: [{ message, status: 400 }] } },
    ]) {
      reply = rejection;
      const sentBefore = bodies.length;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await agent.get('/api/v1/discover/manga').query(query);
        assert.strictEqual(res.status, 503);
        assert.deepStrictEqual(res.body, unavailable);
        assert.doesNotMatch(res.text, /Example rejection|Unknown Example/);
      }
      assert.strictEqual(bodies.length, sentBefore + 2);
    }
  });

  it('lists filter names under the content policy', async () => {
    const getOptions = mock.method(
      AnilistAPI.prototype,
      'getMangaFilterOptions',
      async () => ({
        genres: [
          { name: 'Drama', isAdult: false },
          { name: 'Action', isAdult: false },
          { name: 'Hentai', isAdult: true },
        ],
        tags: [
          { name: 'Pirates', isAdult: false },
          { name: 'Example Adult Tag', isAdult: true },
          { name: 'Isekai', isAdult: false },
        ],
      })
    );
    const agent = await loginAs('friend@seerr.dev');

    let res = await agent.get('/api/v1/discover/manga/filters');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, {
      genres: ['Action', 'Drama'],
      tags: ['Isekai', 'Pirates'],
      formats: ['MANGA', 'ONE_SHOT'],
    });

    getSettings().main.mangaIncludeAdult = true;
    getSettings().main.mangaIncludeNovels = true;
    res = await agent.get('/api/v1/discover/manga/filters');
    assert.deepStrictEqual(res.body, {
      genres: ['Action', 'Drama', 'Hentai'],
      tags: ['Example Adult Tag', 'Isekai', 'Pirates'],
      formats: ['MANGA', 'ONE_SHOT', 'NOVEL'],
    });
    assert.strictEqual(getOptions.mock.callCount(), 2);
  });

  it('reads the filter names from AniList once a day at most', async () => {
    const bodies = stubAnilistNetwork(() => ({ data: catalog }));
    const agent = await loginAs('friend@seerr.dev');

    const first = await agent.get('/api/v1/discover/manga/filters');
    const second = await agent.get('/api/v1/discover/manga/filters');

    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.deepStrictEqual(second.body, first.body);
    assert.strictEqual(bodies.length, 1);
    assert.match(bodies[0].query, /GenreCollection/);
  });

  it('reports filter name failures with fixed text and logs codes only', async () => {
    let failure: Error = new AnilistRateLimitedError(30);
    mock.method(AnilistAPI.prototype, 'getMangaFilterOptions', async () => {
      throw failure;
    });
    const logged = mock.method(logger, 'error', () => logger);
    const agent = await loginAs('friend@seerr.dev');

    let res = await agent.get('/api/v1/discover/manga/filters');
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.headers['retry-after'], '30');

    failure = new AnilistGraphQLError('Example failure detail', 400);
    res = await agent.get('/api/v1/discover/manga/filters');
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.body, unavailable);

    const failureLogs = logged.mock.calls
      .map((call) => call.arguments as unknown[])
      .filter(([text]) => text === 'Failed to retrieve manga filter options');
    assert.deepStrictEqual(
      failureLogs.map(([, meta]) => meta),
      [
        { label: 'Discover Manga', errorName: 'AnilistRateLimitedError' },
        {
          label: 'Discover Manga',
          errorName: 'AnilistGraphQLError',
          status: 400,
        },
      ]
    );
    assert.doesNotMatch(
      JSON.stringify(logged.mock.calls.map((call) => call.arguments)),
      /Example failure detail/
    );
  });

  it('answers like an unknown route while manga is disabled', async () => {
    getSettings().main.enabledMediaCategories = {
      ...getSettings().main.enabledMediaCategories,
      manga: false,
    };
    const getOptions = mock.method(
      AnilistAPI.prototype,
      'getMangaFilterOptions'
    );
    const agent = await loginAs('friend@seerr.dev');

    const res = await agent.get('/api/v1/discover/manga/filters');

    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.body, { status: 404, message: 'Not found.' });
    assert.strictEqual(getOptions.mock.callCount(), 0);
  });
});

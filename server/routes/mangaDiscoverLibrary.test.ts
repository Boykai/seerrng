import AnilistAPI from '@server/api/anilist';
import { AnilistRateLimitedError } from '@server/api/anilist/failures';
import type { AnilistMangaSummary } from '@server/api/anilist/manga';
import { MediaStatus } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaSourceBinding, {
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import { createMangaMedia } from '@server/lib/mangaMedia';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';
import router from './index';

setupTestDb();

const settings = getSettings();
const original = {
  categories: settings.main.enabledMediaCategories,
  includeAdult: settings.main.mangaIncludeAdult,
  includeNovels: settings.main.mangaIncludeNovels,
  cacheImages: settings.main.cacheImages,
  suwayomi: settings.suwayomi,
};
/** Success responses from the route under test that break the API spec. */
const responseErrors: string[] = [];
// Entity dates stay Date objects until the body is serialized.
const UNSERIALIZED_DATE = /\/mediaInfo\/\w+At must be string$/;

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    // Test-only session middleware has no network listener or real secret.
    // codeql[js/clear-text-cookie]
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateResponses: {
        onError: (error, body, req) => {
          // Error bodies follow the spec's convention of a description only.
          const generic =
            typeof body === 'object' && body !== null && 'status' in body;
          if (
            !generic &&
            /^\/api\/v1\/discover\/manga\/library\b/.test(req.originalUrl) &&
            !UNSERIALIZED_DATE.test(error.message)
          ) {
            responseErrors.push(`${req.method} ${req.path}: ${error.message}`);
          }
        },
      },
      validateSecurity: false,
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
    ) =>
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message })
  );
  return app;
};

const app = createApp();

const loginAs = async (email: string) => {
  const localLogin = settings.main.localLogin;
  settings.main.localLogin = true;
  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/v1/auth/local')
      .send({ email, password: 'test1234' });
    assert.equal(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = localLogin;
  }
};

const instance = (id: number) =>
  ({ id, name: `Library ${id}` }) as SuwayomiSettings;

const manga = (
  id: number,
  overrides: Partial<AnilistMangaSummary> = {}
): AnilistMangaSummary => ({
  id,
  titles: { english: `Sample Manga ${id}` },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  ...overrides,
});

const mockSummaries = (
  summary: (id: number) => AnilistMangaSummary | undefined = (id) => manga(id)
) =>
  mock.method(
    AnilistAPI.prototype,
    'getMangaSummariesByIds',
    async (ids: number[]) =>
      ids
        .map(summary)
        .filter((item): item is AnilistMangaSummary => item !== undefined)
        .reverse()
  );

let nextKey = 1;
const seedBinding = (
  anilistId: number,
  createdAt: string,
  overrides: Partial<MangaSourceBinding> = {}
) => {
  const key = nextKey++;
  return getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId: 1,
      sourceId: '1000',
      url: `/library-item/${key}`,
      urlHash: hashMangaSourceUrl(`/library-item/${key}`),
      anilistId,
      suwayomiMangaId: key,
      title: `Library item ${key}`,
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state: MangaBindingState.ACTIVE,
      inLibrary: true,
      availability: MediaStatus.UNKNOWN,
      chapterCount: 3,
      downloadCount: 0,
      createdAt: new Date(createdAt),
      ...overrides,
    })
  );
};

const resultIds = (body: { results: { id: number }[] }) =>
  body.results.map((result) => result.id);

beforeEach(() => {
  settings.main.enabledMediaCategories = {
    ...original.categories,
    manga: true,
  };
  settings.main.mangaIncludeAdult = false;
  settings.main.mangaIncludeNovels = false;
  // Keep image warming from reaching the AniList CDN.
  settings.main.cacheImages = false;
  settings.suwayomi = [instance(1), instance(2)];
});

afterEach(() => {
  mock.restoreAll();
  settings.main.enabledMediaCategories = original.categories;
  settings.main.mangaIncludeAdult = original.includeAdult;
  settings.main.mangaIncludeNovels = original.includeNovels;
  settings.main.cacheImages = original.cacheImages;
  settings.suwayomi = original.suwayomi;
  try {
    assert.deepEqual(responseErrors, []);
  } finally {
    responseErrors.length = 0;
  }
});

describe('manga library list', () => {
  it('lists each library title once, most recently added first', async () => {
    // A title's added date is its earliest active library binding.
    await seedBinding(10, '2024-01-01T00:00:00Z');
    await seedBinding(10, '2024-05-01T00:00:00Z', { instanceId: 2 });
    await seedBinding(20, '2024-02-01T00:00:00Z');
    await seedBinding(30, '2024-02-01T00:00:00Z');
    await seedBinding(80, '2023-01-01T00:00:00Z', {
      state: MangaBindingState.ORPHANED,
    });
    await seedBinding(80, '2024-04-01T00:00:00Z');
    // Not in the library: orphaned, rejected, unlisted or on an instance
    // that is no longer configured.
    await seedBinding(40, '2024-06-01T00:00:00Z', {
      state: MangaBindingState.ORPHANED,
    });
    await seedBinding(50, '2024-06-01T00:00:00Z', {
      state: MangaBindingState.REJECTED,
    });
    await seedBinding(60, '2024-06-01T00:00:00Z', { inLibrary: false });
    await seedBinding(70, '2024-06-01T00:00:00Z', { instanceId: 9 });
    await createMangaMedia(dataSource.manager, 20, MediaStatus.AVAILABLE);
    const read = mockSummaries();
    const agent = await loginAs('friend@seerr.dev');

    const res = await agent.get('/api/v1/discover/manga/library');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(read.mock.callCount(), 1);
    assert.deepEqual(read.mock.calls[0]?.arguments, [[80, 20, 30, 10]]);
    assert.deepEqual(resultIds(res.body), [80, 20, 30, 10]);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.totalPages, 1);
    assert.equal(res.body.totalResults, 4);
    assert.equal(res.body.results[0].mediaType, 'manga');
    assert.equal(res.body.results[0].mediaInfo, undefined);
    assert.equal(res.body.results[1].mediaInfo.status, MediaStatus.AVAILABLE);
    // Cards carry catalog data only, never the library item behind them.
    const serialized = JSON.stringify(res.body);
    for (const hidden of ['/library-item/', 'Library item', 'instanceId']) {
      assert.equal(serialized.includes(hidden), false, hidden);
    }
  });

  it('leaves out titles the content policy excludes without revealing them', async () => {
    await seedBinding(1, '2024-03-01T00:00:00Z');
    await seedBinding(2, '2024-02-01T00:00:00Z');
    await seedBinding(3, '2024-01-01T00:00:00Z');
    await seedBinding(4, '2023-12-01T00:00:00Z');
    // AniList has no title 4.
    mockSummaries((id) =>
      id === 2
        ? manga(id, { isAdult: true })
        : id === 3
          ? manga(id, { format: 'NOVEL' })
          : id === 4
            ? undefined
            : manga(id)
    );
    const agent = await loginAs('friend@seerr.dev');

    const hidden = await agent.get('/api/v1/discover/manga/library');

    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    assert.deepEqual(resultIds(hidden.body), [1]);
    assert.equal(hidden.body.totalResults, 4);
    assert.equal(hidden.body.totalPages, 1);
    assert.equal(JSON.stringify(hidden.body).includes('Sample Manga 2'), false);

    settings.main.mangaIncludeAdult = true;
    settings.main.mangaIncludeNovels = true;
    const shown = await agent.get('/api/v1/discover/manga/library');

    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.deepEqual(resultIds(shown.body), [1, 2, 3]);
  });

  it('answers an empty library without calling AniList', async () => {
    const read = mockSummaries();
    const agent = await loginAs('friend@seerr.dev');
    const empty = { page: 1, totalPages: 1, totalResults: 0, results: [] };

    const none = await agent.get('/api/v1/discover/manga/library');
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.deepEqual(none.body, empty);

    // Bindings from an instance that is no longer configured do not count.
    await seedBinding(5, '2024-01-01T00:00:00Z');
    settings.suwayomi = [];
    const unconfigured = await agent.get('/api/v1/discover/manga/library');
    assert.equal(unconfigured.status, 200, JSON.stringify(unconfigured.body));
    assert.deepEqual(unconfigured.body, empty);
    assert.equal(read.mock.callCount(), 0);
  });

  it('pages through the library 20 titles at a time', async () => {
    for (let id = 1; id <= 25; id += 1) {
      await seedBinding(id, new Date(Date.UTC(2024, 0, id)).toISOString());
    }
    const read = mockSummaries();
    const agent = await loginAs('friend@seerr.dev');

    const first = await agent.get('/api/v1/discover/manga/library');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(
      resultIds(first.body),
      Array.from({ length: 20 }, (_, index) => 25 - index)
    );
    assert.equal(first.body.totalResults, 25);
    assert.equal(first.body.totalPages, 2);

    const second = await agent
      .get('/api/v1/discover/manga/library')
      .query({ page: 2 });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(resultIds(second.body), [5, 4, 3, 2, 1]);
    assert.equal(second.body.page, 2);
    assert.equal(second.body.totalPages, 2);

    const past = await agent
      .get('/api/v1/discover/manga/library')
      .query({ page: 3 });
    assert.equal(past.status, 200, JSON.stringify(past.body));
    assert.deepEqual(past.body, {
      page: 3,
      totalPages: 2,
      totalResults: 25,
      results: [],
    });
    assert.equal(read.mock.callCount(), 2);
  });

  it('answers AniList failures like the other manga routes', async () => {
    await seedBinding(1, '2024-01-01T00:00:00Z');
    const agent = await loginAs('friend@seerr.dev');

    mock.method(AnilistAPI.prototype, 'getMangaSummariesByIds', async () => {
      throw new AnilistRateLimitedError(45);
    });
    const limited = await agent.get('/api/v1/discover/manga/library');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['retry-after'], '45');

    mock.restoreAll();
    mock.method(AnilistAPI.prototype, 'getMangaSummariesByIds', async () => {
      throw new Error('AniList is down');
    });
    const unavailable = await agent.get('/api/v1/discover/manga/library');
    assert.equal(unavailable.status, 503);
    assert.equal(JSON.stringify(unavailable.body).includes('down'), false);
  });

  it('requires a signed-in user and the manga category', async () => {
    await seedBinding(1, '2024-01-01T00:00:00Z');
    const read = mockSummaries();

    const anonymous = await request(app).get('/api/v1/discover/manga/library');
    assert.equal(anonymous.status, 403);

    const agent = await loginAs('friend@seerr.dev');
    settings.main.enabledMediaCategories = {
      ...original.categories,
      manga: false,
    };
    const disabled = await agent.get('/api/v1/discover/manga/library');
    assert.equal(disabled.status, 404);
    assert.equal(read.mock.callCount(), 0);
  });
});

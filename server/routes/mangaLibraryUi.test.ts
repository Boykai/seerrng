import AnilistAPI from '@server/api/anilist';
import { AnilistRateLimitedError } from '@server/api/anilist/failures';
import type {
  AnilistMangaDetails,
  AnilistMangaSummary,
} from '@server/api/anilist/manga';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaSourceBinding, {
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import { createMangaMedia } from '@server/lib/mangaMedia';
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
  cacheImages: settings.main.cacheImages,
};
/** Success responses from the routes under test that break the API spec. */
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
            /^\/api\/v1\/(manga|media)\b/.test(req.originalUrl) &&
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

const details = (id: number): AnilistMangaDetails => ({
  ...manga(id),
  tags: [],
  staff: [],
});

const seedBinding = (
  anilistId: number,
  key: number,
  overrides: Partial<MangaSourceBinding> = {}
) =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId: 1,
      sourceId: '1000',
      url: `/sample/${key}`,
      urlHash: hashMangaSourceUrl(`/sample/${key}`),
      anilistId,
      suwayomiMangaId: key,
      title: `Sample Manga ${key}`,
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state: MangaBindingState.ACTIVE,
      inLibrary: true,
      availability: MediaStatus.UNKNOWN,
      chapterCount: 3,
      downloadCount: 0,
      ...overrides,
    })
  );

beforeEach(() => {
  settings.main.enabledMediaCategories = {
    ...original.categories,
    manga: true,
  };
  settings.main.mangaIncludeAdult = false;
  // Keep image warming from reaching the AniList CDN.
  settings.main.cacheImages = false;
});

afterEach(() => {
  mock.restoreAll();
  settings.main.enabledMediaCategories = original.categories;
  settings.main.mangaIncludeAdult = original.includeAdult;
  settings.main.cacheImages = original.cacheImages;
  try {
    assert.deepEqual(responseErrors, []);
  } finally {
    responseErrors.length = 0;
  }
});

describe('manga batch read', () => {
  it('answers in request order and leaves out unknown and excluded titles', async () => {
    const read = mock.method(
      AnilistAPI.prototype,
      'getMangaSummariesByIds',
      async () => [manga(2), manga(3, { isAdult: true }), manga(1)]
    );
    await createMangaMedia(dataSource.manager, 2, MediaStatus.AVAILABLE);
    const agent = await loginAs('friend@seerr.dev');

    const res = await agent.get('/api/v1/manga').query({ ids: '1,2,3,4,1' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(read.mock.calls[0]?.arguments, [[1, 2, 3, 4]]);
    assert.deepEqual(
      res.body.results.map((result: { id: number }) => result.id),
      [1, 2]
    );
    assert.equal(res.body.results[0].mediaInfo, undefined);
    assert.equal(res.body.results[1].mediaInfo.status, MediaStatus.AVAILABLE);
  });

  it('rejects malformed ID lists without calling AniList', async () => {
    const read = mock.method(AnilistAPI.prototype, 'getMangaSummariesByIds');
    const agent = await loginAs('admin@seerr.dev');

    for (const ids of [
      undefined,
      '',
      '0',
      'abc',
      '1,,2',
      '-1',
      '2147483648',
      Array.from({ length: 51 }, (_, index) => index + 1).join(','),
    ]) {
      const res = await agent
        .get('/api/v1/manga')
        .query(ids === undefined ? {} : { ids });
      assert.equal(res.status, 400, String(ids));
    }
    assert.equal(read.mock.callCount(), 0);
  });

  it('reports AniList rate limits and failures', async () => {
    const agent = await loginAs('admin@seerr.dev');
    mock.method(AnilistAPI.prototype, 'getMangaSummariesByIds', async () => {
      throw new AnilistRateLimitedError(45);
    });
    const limited = await agent.get('/api/v1/manga').query({ ids: '1' });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['retry-after'], '45');

    mock.restoreAll();
    mock.method(AnilistAPI.prototype, 'getMangaSummariesByIds', async () => {
      throw new Error('upstream detail that must stay private');
    });
    const failed = await agent.get('/api/v1/manga').query({ ids: '1' });
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, {
      status: 503,
      message: 'Unable to retrieve manga details.',
    });
  });

  it('is unavailable while the manga category is off', async () => {
    settings.main.enabledMediaCategories = {
      ...original.categories,
      manga: false,
    };
    const read = mock.method(AnilistAPI.prototype, 'getMangaSummariesByIds');
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent.get('/api/v1/manga').query({ ids: '1' });

    assert.equal(res.status, 404);
    assert.equal(read.mock.callCount(), 0);
  });
});

describe('manga details library marker', () => {
  const marker = async (anilistId: number) => {
    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.get(`/api/v1/manga/${anilistId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Record<string, unknown>;
  };

  beforeEach(() => {
    mock.method(AnilistAPI.prototype, 'getMangaDetails', async (id: number) =>
      details(id)
    );
  });

  it('is false without a live binding in a library', async () => {
    await seedBinding(201, 1, { state: MangaBindingState.ORPHANED });
    await seedBinding(201, 2, {
      state: MangaBindingState.REJECTED,
      confidence: MangaBindingConfidence.MANUAL,
      matchedBy: 'manual',
      origin: 'admin',
    });
    await seedBinding(202, 3, { inLibrary: false });

    assert.equal((await marker(200)).inSuwayomiLibrary, false);
    assert.equal((await marker(201)).inSuwayomiLibrary, false);
    assert.equal((await marker(202)).inSuwayomiLibrary, false);
  });

  it('is true for an active binding in a library and reveals nothing else', async () => {
    await seedBinding(203, 4);

    const body = await marker(203);

    assert.equal(body.inSuwayomiLibrary, true);
    // Bindings exist without media, so the marker stands alone.
    assert.equal(body.mediaInfo, undefined);
    const text = JSON.stringify(body);
    for (const leak of [
      'instanceId',
      'sourceId',
      '/sample/',
      'Sample Manga 4',
      'chapterCount',
    ]) {
      assert.equal(text.includes(leak), false, leak);
    }
  });

  it('is not served while the manga category is off', async () => {
    await seedBinding(203, 4);
    settings.main.enabledMediaCategories = {
      ...original.categories,
      manga: false,
    };
    const agent = await loginAs('friend@seerr.dev');

    const res = await agent.get('/api/v1/manga/203');

    assert.equal(res.status, 404);
  });
});

describe('recently added manga', () => {
  // The API refuses reserved characters, so commas travel encoded.
  const RECENT = '/api/v1/media?filter=allavailable&sort=mediaAdded&take=20';
  const types = (...names: string[]) => `&mediaType=${names.join('%2C')}`;

  const seedMovie = () =>
    getRepository(Media).save(
      new Media({
        tmdbId: 990_001,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        mediaAddedAt: new Date('2000-01-01T00:00:00.000Z'),
      })
    );

  it('lists manga by name with its AniList ID', async () => {
    const movie = await seedMovie();
    const manga = await createMangaMedia(
      dataSource.manager,
      30013,
      MediaStatus.PARTIALLY_AVAILABLE
    );
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent.get(RECENT + types('movie', 'tv', 'manga'));

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.results.map((item: { id: number }) => item.id),
      [manga.id, movie.id]
    );
    assert.equal(res.body.results[0].anilistId, 30013);
    assert.equal('anilistId' in res.body.results[1], false);

    const only = await agent.get(RECENT + types('manga'));
    assert.deepEqual(
      only.body.results.map((item: { id: number }) => item.id),
      [manga.id]
    );

    const legacy = await agent.get(RECENT + types('movie', 'tv'));
    assert.deepEqual(
      legacy.body.results.map((item: { id: number }) => item.id),
      [movie.id]
    );
  });

  it('keeps manga unlisted while the manga category is off', async () => {
    settings.main.enabledMediaCategories = {
      ...original.categories,
      manga: false,
    };
    const movie = await seedMovie();
    await createMangaMedia(dataSource.manager, 30013, MediaStatus.AVAILABLE);
    const agent = await loginAs('admin@seerr.dev');

    for (const names of [['manga'], ['movie', 'tv', 'manga']]) {
      const res = await agent.get(RECENT + types(...names));
      assert.equal(res.status, 404, names.join());
    }
    const legacy = await agent.get(RECENT + types('movie', 'tv'));
    assert.equal(legacy.status, 200);
    assert.deepEqual(
      legacy.body.results.map((item: { id: number }) => item.id),
      [movie.id]
    );
  });
});

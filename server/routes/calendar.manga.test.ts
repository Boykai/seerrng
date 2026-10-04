import AnilistAPI from '@server/api/anilist';
import { getRepository } from '@server/datasource';
import { hashMangaSourceUrl } from '@server/entity/MangaSourceBinding';
import { User } from '@server/entity/User';
import { resetMangaReleaseCalendarCache } from '@server/lib/releaseCalendar/manga';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { setupTestDb } from '@server/test/db';
import { graphqlErrors, syntheticFailure } from '@server/test/fakeSuwayomi';
import { serveFakeChapterReleases } from '@server/test/fakeSuwayomiChapterReleases';
import {
  dispatchInstanceFor,
  fakeChapterUrl,
  fakeDispatchManga,
  seedDispatchBinding,
  seedDispatchRequest,
  startFakeDispatchSuwayomi,
  type FakeDispatchSuwayomi,
} from '@server/test/fakeSuwayomiDispatch';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';
import calendarRoutes from './calendar';

setupTestDb();

const settings = getSettings();
const savedCategories = settings.main.enabledMediaCategories;
const savedSuwayomi = settings.suwayomi;

// The calendar never reads ahead of now, so the chapter is an hour old.
const releasedAt = Date.now() - 60 * 60 * 1000;
const day = new Date(releasedAt).toISOString().slice(0, 10);
const range = {
  start: day,
  end: new Date(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10),
};

let fake: FakeDispatchSuwayomi | undefined;

// Requests and responses are validated against the published contract.
const createApp = (userId: number) => {
  const app = express();
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateResponses: true,
      validateSecurity: false,
    })
  );
  app.use((req, _res, next) => {
    getRepository(User)
      .findOneByOrFail({ id: userId })
      .then((user) => {
        req.user = user;
        next();
      }, next);
  });
  app.use('/api/v1/calendar', calendarRoutes);
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
};

/** A Suwayomi instance with one chapter of a title the friend requested. */
const startSuwayomi = async (): Promise<FakeDispatchSuwayomi> => {
  const manga = fakeDispatchManga(11, {
    chapters: [
      {
        id: 1101,
        url: fakeChapterUrl(11, 1),
        chapterNumber: 1,
        uploadDate: releasedAt,
        isDownloaded: true,
      },
    ],
  });
  fake = await startFakeDispatchSuwayomi([manga]);
  serveFakeChapterReleases(fake);
  invalidateSuwayomiClients();
  settings.suwayomi = [dispatchInstanceFor(fake.server, 1)];
  await seedDispatchBinding(manga, { anilistId: 9101 });
  await seedDispatchRequest({
    anilistId: 9101,
    manifest: {
      bindingSourceId: manga.sourceId,
      bindingUrlHash: hashMangaSourceUrl(manga.url),
      suwayomiMangaId: manga.id,
    },
  });
  return fake;
};

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...savedCategories, manga: true };
  invalidateSuwayomiClients();
  settings.suwayomi = [];
  resetMangaReleaseCalendarCache();
  mock.method(
    AnilistAPI.prototype,
    'getMangaSummariesByIds',
    async (ids: readonly number[]) =>
      ids.map((id) => ({
        id,
        titles: { english: 'Calendar Manga' },
        synonyms: [],
        format: 'MANGA',
        isAdult: false,
        genres: [],
      }))
  );
});

afterEach(async () => {
  mock.restoreAll();
  settings.main.enabledMediaCategories = savedCategories;
  invalidateSuwayomiClients();
  settings.suwayomi = savedSuwayomi;
  resetMangaReleaseCalendarCache();
  await fake?.close();
  fake = undefined;
});

describe('manga in the calendar route', () => {
  it('returns documented manga chapter entries', async () => {
    await startSuwayomi();

    const response = await request(createApp(2))
      .get('/api/v1/calendar')
      .query({ ...range, mediaType: 'manga' });

    assert.equal(response.status, 200);
    assert.deepStrictEqual(response.body, {
      results: [
        {
          id: `suwayomi:manga:9101:${day}`,
          source: 'suwayomi',
          mediaType: 'manga',
          title: 'Calendar Manga',
          startsAt: `${day}T00:00:00.000Z`,
          dateType: 'chapter',
          allDay: true,
          mangaId: 9101,
          chapterCount: 1,
          available: true,
          is4k: false,
        },
      ],
      partialSources: [],
      truncated: false,
    });

    const unmonitored = await request(createApp(1))
      .get('/api/v1/calendar')
      .query({
        ...range,
        mediaType: 'manga',
        scope: 'all',
        includeUnmonitored: 'true',
      });
    assert.equal(unmonitored.status, 200);
    assert.deepStrictEqual(
      unmonitored.body.results.map((item: { mangaId: number }) => item.mangaId),
      [9101]
    );
  });

  it('answers with an empty calendar while the manga category is off', async () => {
    const suwayomi = await startSuwayomi();
    settings.main.enabledMediaCategories = {
      ...savedCategories,
      manga: false,
    };

    const response = await request(createApp(2))
      .get('/api/v1/calendar')
      .query({ ...range, mediaType: 'manga' });

    assert.equal(response.status, 200);
    assert.deepStrictEqual(response.body, {
      results: [],
      partialSources: [],
      truncated: false,
    });
    assert.deepStrictEqual(suwayomi.operationNames(), []);
  });

  it('names an unreadable Suwayomi server only to administrators', async () => {
    const suwayomi = await startSuwayomi();
    suwayomi.server.onOperation(
      'ChapterReleases',
      graphqlErrors([syntheticFailure()])
    );

    const viewer = await request(createApp(2))
      .get('/api/v1/calendar')
      .query({ ...range, mediaType: 'manga' });
    assert.equal(viewer.status, 200);
    assert.deepStrictEqual(viewer.body, {
      results: [],
      partialSources: [{ source: 'suwayomi' }],
      truncated: false,
    });

    const admin = await request(createApp(1))
      .get('/api/v1/calendar')
      .query({ ...range, mediaType: 'manga', scope: 'all' });
    assert.equal(admin.status, 200);
    assert.deepStrictEqual(admin.body.partialSources, [
      { source: 'suwayomi', serverId: 1 },
    ]);
  });
});

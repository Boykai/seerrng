import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import AnilistAPI from '@server/api/anilist';
import {
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist/failures';
import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import {
  MangaDispatchError,
  MangaRequestCheckpoint,
} from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { User } from '@server/entity/User';
import notificationManager from '@server/lib/notifications';
import requestDispatchManager from '@server/lib/requestDispatch';
import { getSettings, type SuwayomiSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import type { Express } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';

const TITLE = 900001;

const suwayomi = (id: number, isDefault = false): SuwayomiSettings => ({
  id,
  name: `Suwayomi ${id}`,
  hostname: 'localhost',
  port: 4567,
  useSsl: false,
  baseUrl: '',
  isDefault,
  authMode: 'NONE',
  username: '',
  password: '',
  sourceAllowlist: [],
  preferredLanguages: [],
  scanlatorPreference: [],
  requireCbz: true,
});

const details = (
  overrides: Partial<AnilistMangaDetails> = {}
): AnilistMangaDetails => ({
  id: TITLE,
  titles: { english: 'Sample Manga' },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  tags: [],
  staff: [],
  ...overrides,
});

let app: Express;
let catalog: Map<number, AnilistMangaDetails | null | Error>;
let anilistCalls: number[];
let enqueued: number[];
let savedSuwayomi: SuwayomiSettings[];
let savedCategories: ReturnType<
  typeof getSettings
>['main']['enabledMediaCategories'];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    // Test-only session middleware has no network listener or real secret.
    // codeql[js/clear-text-cookie]
    session({
      secret: 'test-secret',
      cookie: { secure: 'auto' },
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(rateLimit({ windowMs: 60_000, limit: 10_000 }), checkUser);
  app.use('/auth', authRoutes);
  app.use('/request', requestRoutes);
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

before(() => {
  app = createApp();
});

beforeEach(() => {
  const settings = getSettings();
  savedSuwayomi = settings.suwayomi;
  savedCategories = settings.main.enabledMediaCategories;
  settings.suwayomi = [suwayomi(1, true), suwayomi(2)];
  settings.main.enabledMediaCategories = {
    ...savedCategories,
    manga: true,
  };

  catalog = new Map();
  anilistCalls = [];
  mock.method(
    AnilistAPI.prototype,
    'getMangaDetails',
    async (anilistId: number) => {
      anilistCalls.push(anilistId);
      const entry = catalog.get(anilistId);
      if (entry instanceof Error) throw entry;
      return entry === undefined ? details({ id: anilistId }) : entry;
    }
  );
  mock.method(notificationManager, 'sendNotificationIntent', async () => {
    return;
  });
  enqueued = [];
  mock.method(requestDispatchManager, 'enqueue', async (requestId: number) => {
    enqueued.push(requestId);
  });
});

afterEach(async () => {
  await waitForBackgroundTasks();
  mock.restoreAll();
  const settings = getSettings();
  settings.suwayomi = savedSuwayomi;
  settings.main.enabledMediaCategories = savedCategories;
});

setupTestDb();

async function loginAs(email: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

const requestManga = async (
  agent: Awaited<ReturnType<typeof loginAs>>,
  body: Record<string, unknown> = {}
) =>
  agent
    .post('/request')
    .send({ mediaType: MediaType.MANGA, mediaId: TITLE, ...body });

const countMangaRows = async () => ({
  requests: await getRepository(MediaRequest).count({
    where: { type: MediaType.MANGA },
  }),
  media: await getRepository(Media).count({
    where: { mediaType: MediaType.MANGA },
  }),
  manifests: await getRepository(MangaRequestManifest).count(),
});

const NO_ROWS = { requests: 0, media: 0, manifests: 0 };

describe('manga request routes', () => {
  it('records a manga request with its chapter scope and leaves a pending one undispatched', async () => {
    const friend = await loginAs('friend@seerr.dev');

    const response = await requestManga(friend, {
      mangaScope: { scope: 'LATEST_N', latestCount: 5 },
    });

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.type, MediaType.MANGA);
    assert.strictEqual(response.body.status, MediaRequestStatus.PENDING);
    assert.strictEqual(response.body.serverId, 1);
    assert.deepStrictEqual(response.body.mangaScope, {
      scope: 'LATEST_N',
      latestCount: 5,
      rangeStart: null,
      rangeEnd: null,
      awaitingBinding: true,
    });
    const manifest = await getRepository(MangaRequestManifest).findOneOrFail({
      where: { requestId: response.body.id },
    });
    assert.strictEqual(manifest.anilistId, TITLE);
    assert.strictEqual(manifest.instanceId, 1);
    assert.strictEqual(manifest.checkpoint, null);
    assert.strictEqual(manifest.frozenAt, null);
    assert.deepStrictEqual(anilistCalls, [TITLE]);
    assert.deepStrictEqual(enqueued, []);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('refuses excluded and unknown titles and invalid input before writing rows', async () => {
    catalog.set(900002, details({ id: 900002, isAdult: true }));
    catalog.set(900003, details({ id: 900003, format: 'NOVEL' }));
    catalog.set(900004, null);
    const friend = await loginAs('friend@seerr.dev');

    for (const mediaId of [900002, 900003, 900004]) {
      const response = await requestManga(friend, { mediaId });
      assert.strictEqual(response.status, 404, `AniList ${mediaId}`);
      assert.strictEqual(response.body.message, 'Manga not found.');
    }

    const invalidId = await requestManga(friend, { mediaId: 'abc' });
    assert.strictEqual(invalidId.status, 400);
    assert.strictEqual(
      invalidId.body.message,
      'mediaId must be a positive integer AniList ID.'
    );
    const missingId = await friend
      .post('/request')
      .send({ mediaType: MediaType.MANGA });
    assert.strictEqual(missingId.status, 400);
    assert.strictEqual(
      missingId.body.message,
      'mediaId is required for manga requests.'
    );

    const badScope = await requestManga(friend, {
      mangaScope: { scope: 'LATEST_N', latestCount: 0 },
    });
    assert.strictEqual(badScope.status, 400);
    assert.strictEqual(
      badScope.body.message,
      'latestCount must be an integer from 1 to 10000.'
    );
    const reversedRange = await requestManga(friend, {
      mangaScope: { scope: 'RANGE', rangeStart: 10, rangeEnd: 2 },
    });
    assert.strictEqual(reversedRange.status, 400);
    assert.match(reversedRange.body.message, /^rangeEnd must be/);

    const scopedMovie = await friend.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 12345,
      mangaScope: { scope: 'ALL_AT_DISPATCH' },
    });
    assert.strictEqual(scopedMovie.status, 400);
    assert.strictEqual(
      scopedMovie.body.message,
      'mangaScope is only valid for manga requests.'
    );

    assert.deepStrictEqual(anilistCalls, [900002, 900003, 900004]);
    assert.deepStrictEqual(await countMangaRows(), NO_ROWS);
  });

  it('answers 429 with Retry-After when AniList is rate limited and 503 when it is down', async () => {
    catalog.set(900005, new AnilistRateLimitedError(30));
    catalog.set(900006, new AnilistOutageError());
    const friend = await loginAs('friend@seerr.dev');

    const limited = await requestManga(friend, { mediaId: 900005 });
    const down = await requestManga(friend, { mediaId: 900006 });

    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.headers['retry-after'], '30');
    assert.strictEqual(down.status, 503);
    assert.strictEqual(down.body.message, 'Unable to retrieve manga details.');
    assert.deepStrictEqual(await countMangaRows(), NO_ROWS);
  });

  it('refuses manga requests without a Suwayomi server before any AniList call', async () => {
    getSettings().suwayomi = [];
    const friend = await loginAs('friend@seerr.dev');

    const response = await requestManga(friend);

    assert.strictEqual(response.status, 400);
    assert.strictEqual(
      response.body.message,
      'No Suwayomi server is configured for manga requests.'
    );
    assert.deepStrictEqual(anilistCalls, []);
    assert.deepStrictEqual(await countMangaRows(), NO_ROWS);
  });

  it('refuses a second request for the same title', async () => {
    const friend = await loginAs('friend@seerr.dev');

    const first = await requestManga(friend);
    const second = await requestManga(friend);

    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(
      second.body.message,
      'A request for this manga already exists.'
    );
    assert.deepStrictEqual(await countMangaRows(), {
      requests: 1,
      media: 1,
      manifests: 1,
    });
  });

  it('lists, counts and shows manga requests with their scope', async () => {
    const friend = await loginAs('friend@seerr.dev');
    const created = await requestManga(friend, {
      mangaScope: { scope: 'RANGE', rangeStart: 1, rangeEnd: 12.5 },
    });
    assert.strictEqual(created.status, 201);
    const requestedBy = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    const movieMedia = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12345,
        status: MediaStatus.PENDING,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media: movieMedia,
        requestedBy,
        is4k: false,
      })
    );
    const expectedScope = {
      scope: 'RANGE',
      latestCount: null,
      rangeStart: 1,
      rangeEnd: 12.5,
      awaitingBinding: true,
    };
    const admin = await loginAs('admin@seerr.dev');

    const list = await admin
      .get('/request')
      .query({ filter: 'all', mediaType: 'manga' });
    const statusPage = await admin
      .get('/request/status')
      .query({ mediaType: 'manga' });
    const count = await admin.get('/request/count');
    const detail = await admin.get(`/request/${created.body.id}`);
    const statusDetail = await admin.get(`/request/status/${created.body.id}`);

    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(
      list.body.results.map((result: MediaRequest) => result.id),
      [created.body.id]
    );
    assert.deepStrictEqual(list.body.results[0].mangaScope, expectedScope);
    assert.strictEqual(statusPage.status, 200);
    assert.deepStrictEqual(
      statusPage.body.results.map(
        (result: { request: MediaRequest }) => result.request.id
      ),
      [created.body.id]
    );
    assert.deepStrictEqual(
      statusPage.body.results[0].request.mangaScope,
      expectedScope
    );
    assert.strictEqual(count.status, 200);
    assert.strictEqual(count.body.total, 2);
    assert.strictEqual(count.body.manga, 1);
    assert.strictEqual(count.body.movie, 1);
    assert.strictEqual(detail.status, 200);
    assert.deepStrictEqual(detail.body.mangaScope, expectedScope);
    assert.strictEqual(statusDetail.status, 200);
    assert.deepStrictEqual(statusDetail.body.request.mangaScope, expectedScope);
  });

  it('lets an admin edit the scope and instance of a pending manga request until the scope freezes', async () => {
    const friend = await loginAs('friend@seerr.dev');
    const created = await requestManga(friend);
    assert.strictEqual(created.status, 201);
    const admin = await loginAs('admin@seerr.dev');

    const edited = await admin.put(`/request/${created.body.id}`).send({
      mediaType: MediaType.MANGA,
      serverId: 2,
      mangaScope: { scope: 'LATEST_N', latestCount: 3 },
    });

    assert.strictEqual(edited.status, 200);
    assert.strictEqual(edited.body.serverId, 2);
    assert.deepStrictEqual(edited.body.mangaScope, {
      scope: 'LATEST_N',
      latestCount: 3,
      rangeStart: null,
      rangeEnd: null,
      awaitingBinding: true,
    });
    const manifest = await getRepository(MangaRequestManifest).findOneOrFail({
      where: { requestId: created.body.id },
    });
    assert.strictEqual(manifest.instanceId, 2);
    assert.strictEqual(manifest.latestCount, 3);

    const missingServer = await admin
      .put(`/request/${created.body.id}`)
      .send({ mediaType: MediaType.MANGA, serverId: 99 });
    assert.strictEqual(missingServer.status, 400);
    assert.strictEqual(
      missingServer.body.message,
      'The selected Suwayomi server no longer exists.'
    );

    await getRepository(MangaRequestManifest).update(manifest.id, {
      frozenAt: new Date(),
    });
    const frozen = await admin.put(`/request/${created.body.id}`).send({
      mediaType: MediaType.MANGA,
      serverId: 1,
      mangaScope: { scope: 'ALL_AT_DISPATCH' },
    });

    assert.strictEqual(frozen.status, 409);
    assert.strictEqual(
      frozen.body.message,
      'The chapter scope of this request can no longer change.'
    );
    const unchanged = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.body.id },
    });
    assert.strictEqual(unchanged.serverId, 2);
    const frozenManifest = await getRepository(
      MangaRequestManifest
    ).findOneOrFail({ where: { id: manifest.id } });
    assert.strictEqual(frozenManifest.instanceId, 2);
    assert.strictEqual(frozenManifest.latestCount, 3);
  });

  it('refuses a manga scope on another request type when editing', async () => {
    const requestedBy = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12345,
        status: MediaStatus.PENDING,
      })
    );
    const movieRequest = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy,
        is4k: false,
      })
    );
    const admin = await loginAs('admin@seerr.dev');

    const response = await admin
      .put(`/request/${movieRequest.id}`)
      .send({ mangaScope: { scope: 'ALL_AT_DISPATCH' } });

    assert.strictEqual(response.status, 400);
    assert.strictEqual(
      response.body.message,
      'mangaScope is only valid for manga requests.'
    );
  });

  it('queues an approved manga request and retries a failed one from a reset manifest', async () => {
    const friend = await loginAs('friend@seerr.dev');
    const created = await requestManga(friend);
    assert.strictEqual(created.status, 201);
    const admin = await loginAs('admin@seerr.dev');

    const approved = await admin.post(`/request/${created.body.id}/approve`);
    const queuedRetry = await admin.post(`/request/${created.body.id}/retry`);

    assert.strictEqual(approved.status, 200);
    assert.strictEqual(approved.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(approved.body.mangaScope.awaitingBinding, true);
    assert.deepStrictEqual(enqueued, [created.body.id]);
    // An approved request is still queued, so there is nothing to retry.
    assert.strictEqual(queuedRetry.status, 409);
    assert.strictEqual(
      queuedRetry.body.message,
      'This request cannot be retried from its current state.'
    );

    const manifest = await getRepository(MangaRequestManifest).findOneOrFail({
      where: { requestId: created.body.id },
    });
    const frozenAt = new Date();
    await getRepository(MangaRequestManifest).update(manifest.id, {
      checkpoint: MangaRequestCheckpoint.CHAPTERS_FETCHED,
      checkpointAt: new Date(),
      attempts: 7,
      lastError: MangaDispatchError.SUWAYOMI_UNAVAILABLE,
      retryNotBefore: new Date(Date.now() + 60_000),
      frozenAt,
    });
    await getRepository(MediaRequest).update(created.body.id, {
      status: MediaRequestStatus.FAILED,
    });

    const retried = await admin.post(`/request/${created.body.id}/retry`);

    assert.strictEqual(retried.status, 200);
    assert.strictEqual(retried.body.status, MediaRequestStatus.APPROVED);
    // Both the save and the route queue it; the outbox keeps one row.
    assert.ok(enqueued.length > 1);
    assert.ok(enqueued.every((id) => id === created.body.id));
    const reset = await getRepository(MangaRequestManifest).findOneOrFail({
      where: { id: manifest.id },
    });
    assert.strictEqual(reset.checkpoint, null);
    assert.strictEqual(reset.checkpointAt, null);
    assert.strictEqual(reset.attempts, 0);
    assert.strictEqual(reset.lastError, null);
    assert.strictEqual(reset.retryNotBefore, null);
    // The frozen scope stays; dispatch replays its steps against it.
    assert.strictEqual(reset.frozenAt?.getTime(), frozenAt.getTime());
    assert.strictEqual(
      (
        await getRepository(MediaRequest).findOneOrFail({
          where: { id: created.body.id },
        })
      ).status,
      MediaRequestStatus.APPROVED
    );
  });
});

import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import AnilistAPI from '@server/api/anilist';
import {
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist/failures';
import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import {
  MangaAttentionCode,
  MangaChapterQueueState,
  MangaDispatchError,
  MangaRequestCheckpoint,
} from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { User } from '@server/entity/User';
import notificationManager from '@server/lib/notifications';
import requestDispatchManager from '@server/lib/requestDispatch';
import { getSettings, type SuwayomiSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import * as instanceAdmission from '@server/lib/suwayomi/instanceAdmission';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import { graphqlErrors } from '@server/test/fakeSuwayomi';
import {
  dispatchInstanceFor,
  fakeDispatchChapters,
  fakeDispatchManga,
  seedDispatchBinding,
} from '@server/test/fakeSuwayomiDispatch';
import {
  PROGRESS_READ_OPERATIONS,
  assertProgressTraffic,
  seedProgressRequest,
  startFakeProgressSuwayomi,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
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

const FOLLOW_OFF = {
  enabled: false,
  stopReason: null,
  lastCheckAt: null,
  nextCheckAt: null,
};

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
      follow: FOLLOW_OFF,
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
      follow: FOLLOW_OFF,
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
      follow: FOLLOW_OFF,
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

describe('manga chapter retry route', () => {
  let fake: FakeProgressSuwayomi | undefined;

  afterEach(async () => {
    if (!fake) return;
    try {
      assertProgressTraffic(
        fake.server,
        new Set([...PROGRESS_READ_OPERATIONS, 'EnqueueChapters'])
      );
    } finally {
      invalidateSuwayomiClients();
      await fake.close();
      fake = undefined;
    }
  });

  /**
   * Friend's approved request, enqueued on a fake instance 1, whose first
   * chapter failed there: the poll recorded CHAPTER_ERROR.
   */
  const seedFailedChapter = async () => {
    const manga = fakeDispatchManga(11, {
      inLibrary: true,
      chapters: fakeDispatchChapters(11, [1, 2]),
    });
    const started = await startFakeProgressSuwayomi([manga]);
    fake = started;
    invalidateSuwayomiClients();
    getSettings().suwayomi = [dispatchInstanceFor(started.server)];
    await seedDispatchBinding(manga);
    const seeded = await seedProgressRequest(manga, {
      mediaStatus: MediaStatus.PROCESSING,
    });
    started.state.queue.push(1101, 1102);
    started.queueItems.set(1101, { state: 'ERROR', tries: 3 });
    const [failed, waiting] = seeded.rows;
    await getRepository(MangaRequestChapter).update(failed.id, {
      lastQueueState: MangaChapterQueueState.ERROR,
    });
    await getRepository(MangaRequestChapter).update(waiting.id, {
      lastQueueState: MangaChapterQueueState.QUEUED,
    });
    await getRepository(MangaRequestManifest).update(seeded.manifest.id, {
      attentionCode: MangaAttentionCode.CHAPTER_ERROR,
      attentionAt: new Date(),
      chaptersTotal: 2,
      chaptersQueued: 1,
      chaptersErrored: 1,
    });
    const owner = await getRepository(MediaRequest).findOneOrFail({
      where: { id: seeded.request.id },
      relations: { requestedBy: true },
    });
    assert.strictEqual(owner.requestedBy.email, 'friend@seerr.dev');
    return {
      fake: started,
      requestId: seeded.request.id,
      manifestId: seeded.manifest.id,
    };
  };

  const attentionOf = async (manifestId: number) =>
    (
      await getRepository(MangaRequestManifest).findOneByOrFail({
        id: manifestId,
      })
    ).attentionCode;

  it('refuses the requester and lets an administrator queue the failed chapters again, once', async () => {
    const { fake, requestId, manifestId } = await seedFailedChapter();
    const admission = mock.method(
      instanceAdmission,
      'runWithSuwayomiInstanceAdmission'
    );
    const friend = await loginAs('friend@seerr.dev');
    const admin = await loginAs('admin@seerr.dev');

    const denied = await friend.post(`/request/${requestId}/retry`);

    assert.strictEqual(denied.status, 403);
    assert.strictEqual(
      denied.body.message,
      'You do not have permission to retry this request.'
    );
    assert.deepStrictEqual(fake.operationNames(), []);

    const retried = await admin.post(`/request/${requestId}/retry`);

    assert.strictEqual(retried.status, 200);
    assert.strictEqual(retried.body.status, MediaRequestStatus.APPROVED);
    assert.deepStrictEqual(fake.enqueuedIds(), [1101]);
    // The retry queues the chapters itself; dispatch does not run again.
    assert.deepStrictEqual(enqueued, []);
    assert.strictEqual(admission.mock.callCount(), 0);
    const manifest = await getRepository(MangaRequestManifest).findOneByOrFail({
      id: manifestId,
    });
    assert.strictEqual(manifest.attentionCode, null);
    assert.strictEqual(
      manifest.checkpoint,
      MangaRequestCheckpoint.CHAPTERS_ENQUEUED
    );

    const again = await admin.post(`/request/${requestId}/retry`);

    assert.strictEqual(again.status, 409);
    assert.strictEqual(
      again.body.message,
      'This request cannot be retried from its current state.'
    );
    assert.deepStrictEqual(fake.enqueuedIds(), [1101]);
  });

  it('answers 503, 502 or 409 when the manga service fails, and leaves the request as it was', async () => {
    const { fake, requestId, manifestId } = await seedFailedChapter();
    const admin = await loginAs('admin@seerr.dev');

    fake.failNext('Queue');
    const unavailable = await admin.post(`/request/${requestId}/retry`);

    assert.strictEqual(unavailable.status, 503);
    assert.strictEqual(
      unavailable.body.message,
      'The manga service is unavailable. Try again later.'
    );

    // The chapter IDs were gone by the time they were queued: no outage, so
    // trying again won't help.
    fake.server.onOperation(
      'EnqueueChapters',
      graphqlErrors(['Chapter not found'])
    );
    const rejected = await admin.post(`/request/${requestId}/retry`);

    assert.strictEqual(rejected.status, 502);
    assert.strictEqual(
      rejected.body.message,
      'The manga service could not queue the chapters.'
    );
    assert.deepStrictEqual(fake.enqueuedIds(), [1101]);

    getSettings().suwayomi = [];
    const removed = await admin.post(`/request/${requestId}/retry`);

    assert.strictEqual(removed.status, 409);
    assert.strictEqual(
      removed.body.message,
      'The manga service this request was sent to is no longer configured.'
    );
    assert.deepStrictEqual(fake.enqueuedIds(), [1101]);
    assert.strictEqual(
      await attentionOf(manifestId),
      MangaAttentionCode.CHAPTER_ERROR
    );
  });
});

describe('manga follow consent', () => {
  let fake: FakeProgressSuwayomi | undefined;

  afterEach(async () => {
    if (!fake) return;
    invalidateSuwayomiClients();
    await fake.close();
    fake = undefined;
  });

  const followOf = async (requestId: number) => {
    const manifest = await getRepository(MangaRequestManifest).findOneOrFail({
      where: { requestId },
    });
    return {
      enabled: manifest.followEnabled,
      stopReason: manifest.followStopReason,
      nextAt: manifest.followNextAt,
    };
  };

  const setStatus = (requestId: number, status: MediaRequestStatus) =>
    getRepository(MediaRequest).update(requestId, { status });

  it('lets the owner turn following on when requesting, and nobody on their behalf', async () => {
    const friend = await loginAs('friend@seerr.dev');
    const admin = await loginAs('admin@seerr.dev');

    const owned = await requestManga(friend, { mangaFollow: true });

    assert.strictEqual(owned.status, 201);
    assert.deepStrictEqual(owned.body.mangaScope.follow, {
      ...FOLLOW_OFF,
      enabled: true,
    });
    assert.deepStrictEqual(await followOf(owned.body.id), {
      enabled: true,
      stopReason: null,
      nextAt: null,
    });

    const onBehalf = await requestManga(admin, {
      mediaId: TITLE + 1,
      userId: 2,
      mangaFollow: true,
    });

    assert.strictEqual(onBehalf.status, 403);
    assert.strictEqual(
      onBehalf.body.message,
      'Following new chapters can only be turned on by the owner of a manga request.'
    );

    const invalid = await requestManga(friend, {
      mediaId: TITLE + 2,
      mangaFollow: 'yes',
    });

    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalid.body.message, 'mangaFollow must be a boolean.');

    const movie = await friend
      .post('/request')
      .send({ mediaType: MediaType.MOVIE, mediaId: 12345, mangaFollow: true });

    assert.strictEqual(movie.status, 400);
    assert.strictEqual(
      movie.body.message,
      'mangaFollow is only valid for manga requests.'
    );
    assert.deepStrictEqual(await countMangaRows(), {
      requests: 1,
      media: 1,
      manifests: 1,
    });

    // An administrator's own request may follow; asking for less is fine too.
    const own = await requestManga(admin, {
      mediaId: TITLE + 3,
      mangaFollow: true,
    });
    const declined = await requestManga(admin, {
      mediaId: TITLE + 4,
      userId: 2,
      mangaFollow: false,
    });

    assert.strictEqual(own.status, 201);
    assert.strictEqual(own.body.mangaScope.follow.enabled, true);
    assert.strictEqual(declined.status, 201);
    assert.strictEqual(declined.body.mangaScope.follow.enabled, false);
  });

  it('refuses mangaFollow when editing, so an edit can never opt the owner in', async () => {
    const friend = await loginAs('friend@seerr.dev');
    const created = await requestManga(friend);
    const admin = await loginAs('admin@seerr.dev');

    const edited = await admin.put(`/request/${created.body.id}`).send({
      mediaType: MediaType.MANGA,
      mangaFollow: true,
    });

    assert.strictEqual(edited.status, 400);
    assert.strictEqual(
      edited.body.message,
      'mangaFollow cannot be edited here; use PUT /request/{requestId}/follow.'
    );
    assert.strictEqual((await followOf(created.body.id)).enabled, false);
  });

  it('lets only the owner turn following on, and the owner or a request manager turn it off', async () => {
    const friend = await loginAs('friend@seerr.dev');
    const created = await requestManga(friend);
    const requestId = created.body.id;
    const admin = await loginAs('admin@seerr.dev');
    const demo = await loginAs('demo@seerr.dev');

    const adminOn = await admin
      .put(`/request/${requestId}/follow`)
      .send({ enabled: true });

    assert.strictEqual(adminOn.status, 403);
    assert.strictEqual(
      adminOn.body.message,
      'Only the request owner can turn on following new chapters.'
    );
    assert.strictEqual((await followOf(requestId)).enabled, false);

    const ownerOn = await friend
      .put(`/request/${requestId}/follow`)
      .send({ enabled: true });

    assert.strictEqual(ownerOn.status, 200);
    assert.strictEqual(ownerOn.body.id, requestId);
    assert.deepStrictEqual(ownerOn.body.mangaScope.follow, {
      ...FOLLOW_OFF,
      enabled: true,
    });

    const strangerOff = await demo
      .put(`/request/${requestId}/follow`)
      .send({ enabled: false });

    assert.strictEqual(strangerOff.status, 403);
    assert.strictEqual((await followOf(requestId)).enabled, true);

    const adminOff = await admin
      .put(`/request/${requestId}/follow`)
      .send({ enabled: false });
    const adminOffAgain = await admin
      .put(`/request/${requestId}/follow`)
      .send({ enabled: false });

    assert.strictEqual(adminOff.status, 200);
    assert.deepStrictEqual(adminOff.body.mangaScope.follow, FOLLOW_OFF);
    assert.strictEqual(adminOffAgain.status, 200);
    assert.deepStrictEqual(adminOffAgain.body.mangaScope.follow, FOLLOW_OFF);

    const invalid = await friend
      .put(`/request/${requestId}/follow`)
      .send({ enabled: 'yes' });
    const missing = await friend
      .put('/request/999999/follow')
      .send({ enabled: true });
    const malformed = await friend
      .put('/request/abc/follow')
      .send({ enabled: true });

    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalid.body.message, 'enabled must be a boolean.');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(malformed.status, 404);
  });

  it('turns following on only for pending, approved or completed manga requests the owner may still make', async () => {
    const friend = await loginAs('friend@seerr.dev');
    const created = await requestManga(friend);
    const requestId = created.body.id;
    const enable = () =>
      friend.put(`/request/${requestId}/follow`).send({ enabled: true });

    for (const status of [
      MediaRequestStatus.DECLINED,
      MediaRequestStatus.FAILED,
    ]) {
      await setStatus(requestId, status);
      const refused = await enable();

      assert.strictEqual(refused.status, 409);
      assert.strictEqual(
        refused.body.message,
        'Following new chapters can only be turned on for pending, approved, or completed requests.'
      );
    }
    // Turning it off is always allowed.
    const off = await friend
      .put(`/request/${requestId}/follow`)
      .send({ enabled: false });
    assert.strictEqual(off.status, 200);

    for (const status of [
      MediaRequestStatus.APPROVED,
      MediaRequestStatus.COMPLETED,
    ]) {
      await setStatus(requestId, status);
      const allowed = await enable();

      assert.strictEqual(allowed.status, 200);
      assert.strictEqual(allowed.body.mangaScope.follow.enabled, true);
    }

    const owner = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    await getRepository(User).update(owner.id, { permissions: 0 });
    const unpermitted = await enable();

    assert.strictEqual(unpermitted.status, 403);
    assert.strictEqual(
      unpermitted.body.message,
      'You do not have permission to request manga.'
    );

    const movieMedia = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12345,
        status: MediaStatus.PENDING,
      })
    );
    const movie = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media: movieMedia,
        requestedBy: owner,
        is4k: false,
      })
    );
    const notManga = await friend
      .put(`/request/${movie.id}/follow`)
      .send({ enabled: true });

    assert.strictEqual(notManga.status, 400);
    assert.strictEqual(
      notManga.body.message,
      'Following new chapters is only available for manga requests.'
    );
  });

  it('turns following off without touching queued chapters, and on again due at once', async () => {
    const manga = fakeDispatchManga(11, {
      inLibrary: true,
      chapters: fakeDispatchChapters(11, [1, 2]),
    });
    fake = await startFakeProgressSuwayomi([manga]);
    invalidateSuwayomiClients();
    getSettings().suwayomi = [dispatchInstanceFor(fake.server)];
    await seedDispatchBinding(manga);
    fake.state.queue.push(1101, 1102);
    const lastCheckAt = new Date('2026-10-01T06:07:00.000Z');
    const seeded = await seedProgressRequest(manga, {
      status: MediaRequestStatus.COMPLETED,
      owned: true,
      manifest: {
        followEnabled: true,
        followLastAt: lastCheckAt,
        followNextAt: new Date(Date.now() + 3_600_000),
      },
    });
    const requestId = seeded.request.id;
    const friend = await loginAs('friend@seerr.dev');

    const off = await friend
      .put(`/request/${requestId}/follow`)
      .send({ enabled: false });

    assert.strictEqual(off.status, 200);
    assert.deepStrictEqual(await followOf(requestId), {
      enabled: false,
      stopReason: null,
      nextAt: null,
    });
    assert.deepStrictEqual(fake.operationNames(), []);
    assert.deepStrictEqual(fake.state.queue, [1101, 1102]);
    assert.strictEqual(
      await getRepository(MangaRequestChapter).count({
        where: { manifestId: seeded.manifest.id },
      }),
      2
    );
    assert.strictEqual(await getRepository(MangaChapterOwnership).count(), 2);

    // The follow job stopped it at the end of a closed range.
    await getRepository(MangaRequestManifest).update(seeded.manifest.id, {
      followStopReason: 'RANGE_COMPLETE',
      followNextAt: new Date(Date.now() + 3_600_000),
    });

    const on = await friend
      .put(`/request/${requestId}/follow`)
      .send({ enabled: true });

    assert.strictEqual(on.status, 200);
    assert.deepStrictEqual(on.body.mangaScope.follow, {
      enabled: true,
      stopReason: null,
      lastCheckAt: lastCheckAt.toISOString(),
      nextCheckAt: null,
    });
    assert.deepStrictEqual(await followOf(requestId), {
      enabled: true,
      stopReason: null,
      nextAt: null,
    });
    assert.deepStrictEqual(fake.operationNames(), []);
    assert.strictEqual(
      (
        await getRepository(MediaRequest).findOneOrFail({
          where: { id: requestId },
        })
      ).status,
      MediaRequestStatus.COMPLETED
    );
  });
});

import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import type { MediaRequest as MediaRequestEntity } from '@server/entity/MediaRequest';
import type { RequestDispatchOutbox as RequestDispatchOutboxEntity } from '@server/entity/RequestDispatchOutbox';
import type { SuwayomiSettings } from '@server/lib/settings';
import {
  runsOnPostgres,
  setupPostgresApplication,
} from '@server/test/postgresApplication';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import request from 'supertest';

// These tests need Node's test runner and SEERR_TEST_POSTGRES_URL. The
// PostgreSQL step of the migration checks provides both.
const postgresIt = runsOnPostgres ? it : it.skip;
const application = setupPostgresApplication();

// The application is loaded only after it points at this run's database.
const loadModules = async () => {
  const { default: AnilistAPI } = await import('@server/api/anilist');
  const { MangaDispatchError, MangaRequestCheckpoint } =
    await import('@server/constants/mangaRequest');
  const { MediaRequestStatus, MediaStatus, MediaType } =
    await import('@server/constants/media');
  const { default: dataSource, getRepository } =
    await import('@server/datasource');
  const { default: MangaRequestManifest } =
    await import('@server/entity/MangaRequestManifest');
  const { default: Media } = await import('@server/entity/Media');
  const { MediaRequest } = await import('@server/entity/MediaRequest');
  const { default: MediaRequestStatusEvent } =
    await import('@server/entity/MediaRequestStatusEvent');
  const { RequestDispatchOutbox } =
    await import('@server/entity/RequestDispatchOutbox');
  const { User } = await import('@server/entity/User');
  const { default: notificationManager } =
    await import('@server/lib/notifications');
  const { default: requestDispatchManager, MAX_REQUEST_DISPATCH_ATTEMPTS } =
    await import('@server/lib/requestDispatch');
  const requestStatus = await import('@server/lib/requestStatus');
  const { getSettings } = await import('@server/lib/settings');
  const { default: logger } = await import('@server/logger');
  const { checkUser } = await import('@server/middleware/auth');
  const { default: authRoutes } = await import('@server/routes/auth');
  const { default: requestRoutes } = await import('@server/routes/request');
  const { MediaRequestSubscriber } =
    await import('@server/subscriber/MediaRequestSubscriber');
  const { waitForBackgroundTasks } =
    await import('@server/utils/backgroundTasks');
  return {
    AnilistAPI,
    MangaDispatchError,
    MangaRequestCheckpoint,
    MediaRequestStatus,
    MediaStatus,
    MediaType,
    dataSource,
    getRepository,
    MangaRequestManifest,
    Media,
    MediaRequest,
    MediaRequestStatusEvent,
    RequestDispatchOutbox,
    User,
    notificationManager,
    requestDispatchManager,
    MAX_REQUEST_DISPATCH_ATTEMPTS,
    requestStatus,
    getSettings,
    logger,
    checkUser,
    authRoutes,
    requestRoutes,
    MediaRequestSubscriber,
    waitForBackgroundTasks,
  };
};

let modules: Awaited<ReturnType<typeof loadModules>>;
let server: http.Server;

const createApp = () => {
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
  app.use(rateLimit({ windowMs: 60_000, limit: 10_000 }), modules.checkUser);
  app.use('/auth', modules.authRoutes);
  app.use('/request', modules.requestRoutes);
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
};

if (runsOnPostgres) {
  before(async () => {
    await application.ready();
    modules = await loadModules();
    server = http.createServer(createApp());
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    application.allowPort((server.address() as AddressInfo).port);
  });

  after(async () => {
    if (!server?.listening) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  afterEach(async () => {
    await modules?.waitForBackgroundTasks();
    mock.restoreAll();
  });
}

const fingerprintOf = (stage: string) =>
  `${stage}:0:unknown:unknown:unknown:0:unknown`;

const eventsOf = (requestId: number) =>
  modules.getRepository(modules.MediaRequestStatusEvent).find({
    where: { requestId },
    order: { id: 'ASC' },
  });

type StatusEventRow = Awaited<ReturnType<typeof eventsOf>>[number];

// A retry records an approved entry named after the latest event before it.
const assertRetryEntry = (entry: StatusEventRow, previous: StatusEventRow) => {
  assert.strictEqual(
    entry.fingerprint,
    `retry:${previous.id}:${previous.attempt}`
  );
  assert.strictEqual(
    entry.stage,
    modules.requestStatus.RequestStatusStage.APPROVED
  );
  assert.strictEqual(
    entry.message,
    'The request was retried and is waiting to be dispatched.'
  );
};

const outboxOf = (requestId: number): Promise<RequestDispatchOutboxEntity[]> =>
  modules
    .getRepository(modules.RequestDispatchOutbox)
    .find({ where: { requestId }, order: { id: 'ASC' } });

const createMovieRequest = async (
  tmdbId: number
): Promise<MediaRequestEntity> => {
  const { getRepository, Media, MediaRequest, User } = modules;
  const { MediaRequestStatus, MediaStatus, MediaType } = modules;
  const requestedBy = await getRepository(User).findOneByOrFail({
    email: 'friend@seerr.dev',
  });
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      isAutoRequest: false,
    })
  );
};

// Request saves queue their dispatch as usual; nothing delivers it.
const holdDispatches = () =>
  mock.method(
    modules.requestDispatchManager as unknown as {
      dispatch: (record: RequestDispatchOutboxEntity) => void;
    },
    'dispatch',
    () => undefined
  );

const statusEvent = (
  requestId: number,
  stage: string,
  overrides: Record<string, unknown> = {}
) =>
  new modules.MediaRequestStatusEvent({
    requestId,
    requestedById: 2,
    mediaId: 1,
    mediaType: modules.MediaType.MOVIE,
    stage,
    attempt: 0,
    downloadCount: 0,
    fingerprint: fingerprintOf(stage),
    ...overrides,
  });

describe('request status events on PostgreSQL', () => {
  postgresIt(
    'records a return to an earlier status in the save that causes it',
    async () => {
      const { getRepository, MediaRequest, MediaRequestStatus } = modules;
      const { RequestStatusStage } = modules.requestStatus;
      holdDispatches();
      const created = await createMovieRequest(92001);
      const repository = getRepository(MediaRequest);

      for (const status of [
        MediaRequestStatus.APPROVED,
        MediaRequestStatus.FAILED,
        MediaRequestStatus.APPROVED,
      ]) {
        created.status = status;
        await repository.save(created);
      }

      assert.strictEqual(
        (await repository.findOneByOrFail({ id: created.id })).status,
        MediaRequestStatus.APPROVED
      );
      const events = await eventsOf(created.id);
      assert.deepStrictEqual(
        events.map(({ stage }) => stage),
        [
          RequestStatusStage.REQUESTED,
          RequestStatusStage.APPROVED,
          RequestStatusStage.FAILED,
          RequestStatusStage.APPROVED,
        ]
      );
      assert.strictEqual(
        events[3].fingerprint,
        `${events[1].fingerprint}:after:${events[2].id}`
      );
    }
  );

  postgresIt(
    'skips a status another writer recorded first and keeps the transaction usable',
    async () => {
      const { dataSource } = modules;
      const { RequestStatusStage, insertRequestStatusEvent } =
        modules.requestStatus;
      const requestId = 92011;
      await insertRequestStatusEvent(
        statusEvent(requestId, RequestStatusStage.APPROVED)
      );
      const [seen] = await eventsOf(requestId);
      // Both writers read the same latest event; the first one commits.
      await insertRequestStatusEvent(
        statusEvent(requestId, RequestStatusStage.FAILED),
        { latestEvent: seen }
      );

      const value = await dataSource.transaction(async (manager) => {
        await insertRequestStatusEvent(
          statusEvent(requestId, RequestStatusStage.FAILED),
          { latestEvent: seen, manager }
        );
        const [row] = await manager.query('SELECT 1 AS "value"');
        return row.value;
      });

      assert.strictEqual(value, 1);
      assert.deepStrictEqual(
        (await eventsOf(requestId)).map(({ fingerprint }) => fingerprint),
        [
          fingerprintOf(RequestStatusStage.APPROVED),
          fingerprintOf(RequestStatusStage.FAILED),
        ]
      );
    }
  );

  postgresIt(
    'fails the transaction on any other insert error and only logs outside one',
    async () => {
      const { dataSource, logger } = modules;
      const { RequestStatusStage, insertRequestStatusEvent } =
        modules.requestStatus;
      const requestId = 92021;
      const warn = mock.method(logger, 'warn', () => logger);
      const invalid = statusEvent(requestId, RequestStatusStage.APPROVED, {
        requestedById: undefined,
      });

      await assert.rejects(
        dataSource.transaction((manager) =>
          insertRequestStatusEvent(invalid, { manager })
        ),
        /null value in column "requestedById"/
      );
      assert.strictEqual(warn.mock.callCount(), 0);

      await insertRequestStatusEvent(invalid);

      assert.strictEqual(warn.mock.callCount(), 1);
      assert.strictEqual(
        warn.mock.calls[0].arguments[0],
        'Unable to persist request status event'
      );
      assert.deepStrictEqual(await eventsOf(requestId), []);
    }
  );

  postgresIt(
    'still fails an insert that conflicts on another key',
    async () => {
      const { dataSource, getRepository, MediaRequestStatusEvent } = modules;
      const { RequestStatusStage, insertRequestStatusEvent } =
        modules.requestStatus;
      const requestId = 92026;
      await insertRequestStatusEvent(
        statusEvent(requestId, RequestStatusStage.APPROVED)
      );
      const [existing] = await eventsOf(requestId);
      // The next id already belongs to a row, as after rows were copied in
      // with their ids.
      const reuseExistingId = () =>
        dataSource.query(
          `SELECT setval(pg_get_serial_sequence('media_request_status_event', 'id'), $1, false)`,
          [existing.id]
        );

      await reuseExistingId();
      await assert.rejects(
        dataSource.transaction((manager) =>
          insertRequestStatusEvent(
            statusEvent(requestId, RequestStatusStage.FAILED),
            { manager }
          )
        ),
        /duplicate key value violates unique constraint "PK_/
      );
      // A conflict clause without a target would hide the same conflict.
      await reuseExistingId();
      await getRepository(MediaRequestStatusEvent)
        .createQueryBuilder()
        .insert()
        .into(MediaRequestStatusEvent)
        .values(statusEvent(requestId, RequestStatusStage.FAILED))
        .orIgnore()
        .execute();
      assert.strictEqual((await eventsOf(requestId)).length, 1);
    }
  );

  postgresIt('cuts long values to their column lengths', async () => {
    const { dataSource } = modules;
    const { RequestStatusStage, insertRequestStatusEvent } =
      modules.requestStatus;
    const requestId = 92031;

    await dataSource.transaction((manager) =>
      insertRequestStatusEvent(
        statusEvent(requestId, RequestStatusStage.DOWNLOADING, {
          service: 's'.repeat(200),
          message: 'm'.repeat(600),
          downloadId: '\u{1F4D6}'.repeat(600),
          estimatedCompletionTime: new Date(Number.NaN),
        }),
        { manager }
      )
    );

    const [event] = await eventsOf(requestId);
    assert.strictEqual(event.service, 's'.repeat(128));
    assert.strictEqual(event.message, 'm'.repeat(512));
    assert.strictEqual(event.downloadId, '\u{1F4D6}'.repeat(512));
    assert.strictEqual(event.estimatedCompletionTime, null);
  });

  postgresIt(
    'records a cancellation once when it is recorded twice in a transaction',
    async () => {
      const { dataSource } = modules;
      const { RequestStatusStage, recordRequestCancellation } =
        modules.requestStatus;
      const created = await createMovieRequest(92041);

      await dataSource.transaction(async (manager) => {
        await recordRequestCancellation(created, { manager });
        await recordRequestCancellation(created, { manager });
        await manager.query('SELECT 1');
      });

      assert.deepStrictEqual(
        (await eventsOf(created.id)).map(({ stage }) => stage),
        [RequestStatusStage.REQUESTED, RequestStatusStage.CANCELLED]
      );
    }
  );

  postgresIt('counts requests by their latest status', async () => {
    const { getRepository, MediaRequest, MediaRequestStatus } = modules;
    const { getRequestStatusPage } = modules.requestStatus;
    holdDispatches();
    const failed = await createMovieRequest(92051);
    await createMovieRequest(92052);
    for (const status of [
      MediaRequestStatus.APPROVED,
      MediaRequestStatus.FAILED,
    ]) {
      failed.status = status;
      await getRepository(MediaRequest).save(failed);
    }

    const page = await getRequestStatusPage({ take: 10, skip: 0 });

    assert.strictEqual(page.results.length, 2);
    const {
      total,
      active,
      attention,
      completed,
      failed: failedCount,
    } = page.counts;
    assert.deepStrictEqual(
      { total, active, attention, completed, failed: failedCount },
      { total: 2, active: 1, attention: 1, completed: 0, failed: 1 }
    );
  });
});

const loginAs = async (email: string) => {
  const settings = modules.getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;
  try {
    const agent = request.agent(server);
    const response = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(response.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
};

const MANGA_TITLE = 900001;

const suwayomiServer = (): SuwayomiSettings => ({
  id: 1,
  name: 'Suwayomi 1',
  hostname: 'localhost',
  port: 4567,
  useSsl: false,
  baseUrl: '',
  isDefault: true,
  authMode: 'NONE',
  username: '',
  password: '',
  sourceAllowlist: [],
  preferredLanguages: [],
  scanlatorPreference: [],
  requireCbz: true,
});

const mangaDetails = (id: number): AnilistMangaDetails => ({
  id,
  titles: { english: 'Sample Manga' },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  tags: [],
  staff: [],
});

describe('request retries on PostgreSQL', () => {
  postgresIt(
    'keeps a retried movie request approved and queues it once',
    async () => {
      const { getRepository, MediaRequest, MediaRequestStatus } = modules;
      const { MediaRequestSubscriber, RequestDispatchOutbox } = modules;
      const { RequestStatusStage } = modules.requestStatus;
      // Every delivery fails, as when the download service is unreachable.
      mock.method(
        MediaRequestSubscriber.prototype,
        'dispatchRequestById',
        async () => ({ delivered: false })
      );
      const created = await createMovieRequest(92101);
      const admin = await loginAs('admin@seerr.dev');

      const approved = await admin.post(`/request/${created.id}/approve`);
      await modules.waitForBackgroundTasks();
      assert.strictEqual(approved.status, 200);
      const [approvalRow] = await outboxOf(created.id);
      assert.ok(approvalRow);
      // The next failed delivery is the last one allowed.
      await getRepository(RequestDispatchOutbox).update(approvalRow.id, {
        attempts: modules.MAX_REQUEST_DISPATCH_ATTEMPTS - 1,
        lastAttemptAt: null,
        nextAttemptAt: null,
      });
      await modules.requestDispatchManager.resume();
      await modules.waitForBackgroundTasks();
      assert.strictEqual(
        (await getRepository(MediaRequest).findOneByOrFail({ id: created.id }))
          .status,
        MediaRequestStatus.FAILED
      );
      assert.deepStrictEqual(await outboxOf(created.id), []);

      const retried = await admin.post(`/request/${created.id}/retry`);
      await modules.waitForBackgroundTasks();
      const latestAfterDispatch = (await eventsOf(created.id)).at(-1);
      const statusPage = await admin.get('/request/status');

      assert.strictEqual(retried.status, 200);
      assert.strictEqual(retried.body.status, MediaRequestStatus.APPROVED);
      assert.strictEqual(
        (await getRepository(MediaRequest).findOneByOrFail({ id: created.id }))
          .status,
        MediaRequestStatus.APPROVED
      );
      const outbox = await outboxOf(created.id);
      assert.strictEqual(outbox.length, 1);
      assert.notStrictEqual(outbox[0].id, approvalRow.id);
      const events = await eventsOf(created.id);
      assert.deepStrictEqual(
        events.map(({ stage }) => stage),
        [
          RequestStatusStage.REQUESTED,
          RequestStatusStage.APPROVED,
          RequestStatusStage.FAILED,
          RequestStatusStage.APPROVED,
          RequestStatusStage.APPROVED,
        ]
      );
      assert.strictEqual(
        events[3].fingerprint,
        `${events[1].fingerprint}:after:${events[2].id}`
      );
      assertRetryEntry(events[4], events[3]);
      // The queued dispatch and the status page's refresh add nothing, so the
      // retry entry is still the latest event.
      assert.strictEqual(latestAfterDispatch?.id, events[4].id);
      assert.strictEqual(events.at(-1)?.id, events[4].id);
      assert.strictEqual(statusPage.status, 200);
      assert.deepStrictEqual(
        statusPage.body.results.map(
          (result: { status: { stage: string } }) => result.status.stage
        ),
        [RequestStatusStage.APPROVED]
      );
      assert.strictEqual(statusPage.body.counts.active, 1);
      assert.strictEqual(statusPage.body.counts.attention, 0);
      assert.strictEqual(statusPage.body.counts.failed, 0);
    }
  );

  postgresIt(
    'keeps a retried manga request approved with its dispatch reset',
    async (t) => {
      const { getRepository, MangaRequestManifest, MediaRequest } = modules;
      const { MangaDispatchError, MangaRequestCheckpoint } = modules;
      const { MediaRequestStatus, MediaType } = modules;
      const { RequestStatusStage } = modules.requestStatus;
      const settings = modules.getSettings();
      const savedSuwayomi = settings.suwayomi;
      const savedCategories = settings.main.enabledMediaCategories;
      settings.suwayomi = [suwayomiServer()];
      settings.main.enabledMediaCategories = {
        ...savedCategories,
        manga: true,
      };
      t.after(() => {
        settings.suwayomi = savedSuwayomi;
        settings.main.enabledMediaCategories = savedCategories;
      });
      mock.method(
        modules.AnilistAPI.prototype,
        'getMangaDetails',
        async (anilistId: number) => mangaDetails(anilistId)
      );
      mock.method(
        modules.notificationManager,
        'sendNotificationIntent',
        async () => undefined
      );
      const enqueued: number[] = [];
      mock.method(
        modules.requestDispatchManager,
        'enqueue',
        async (requestId: number) => {
          enqueued.push(requestId);
        }
      );
      const friend = await loginAs('friend@seerr.dev');
      const created = await friend
        .post('/request')
        .send({ mediaType: MediaType.MANGA, mediaId: MANGA_TITLE });
      assert.strictEqual(created.status, 201);
      const admin = await loginAs('admin@seerr.dev');
      const approved = await admin.post(`/request/${created.body.id}/approve`);
      assert.strictEqual(approved.status, 200);
      const manifest = await getRepository(MangaRequestManifest).findOneOrFail({
        where: { requestId: created.body.id },
      });
      await getRepository(MangaRequestManifest).update(manifest.id, {
        checkpoint: MangaRequestCheckpoint.CHAPTERS_FETCHED,
        checkpointAt: new Date(),
        attempts: 7,
        lastError: MangaDispatchError.SUWAYOMI_UNAVAILABLE,
        retryNotBefore: new Date(Date.now() + 60_000),
        frozenAt: new Date(),
      });
      await getRepository(MediaRequest).update(created.body.id, {
        status: MediaRequestStatus.FAILED,
      });

      const retried = await admin.post(`/request/${created.body.id}/retry`);

      assert.strictEqual(retried.status, 200);
      assert.strictEqual(retried.body.status, MediaRequestStatus.APPROVED);
      assert.strictEqual(
        (
          await getRepository(MediaRequest).findOneByOrFail({
            id: created.body.id,
          })
        ).status,
        MediaRequestStatus.APPROVED
      );
      const reset = await getRepository(MangaRequestManifest).findOneByOrFail({
        id: manifest.id,
      });
      assert.deepStrictEqual(
        {
          checkpoint: reset.checkpoint,
          attempts: reset.attempts,
          lastError: reset.lastError,
          retryNotBefore: reset.retryNotBefore,
        },
        { checkpoint: null, attempts: 0, lastError: null, retryNotBefore: null }
      );
      assert.ok(enqueued.length > 1);
      const events = await eventsOf(created.body.id);
      assert.deepStrictEqual(
        events.map(({ stage }) => stage),
        [
          RequestStatusStage.REQUESTED,
          RequestStatusStage.APPROVED,
          RequestStatusStage.FAILED,
          RequestStatusStage.APPROVED,
          RequestStatusStage.APPROVED,
        ]
      );
      assert.strictEqual(
        events[3].fingerprint,
        `${events[1].fingerprint}:after:${events[2].id}`
      );
      assertRetryEntry(events[4], events[3]);
    }
  );
});

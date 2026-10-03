import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import AnilistAPI from '@server/api/anilist';
import { AnilistRateLimitedError } from '@server/api/anilist/failures';
import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import ExternalAPI from '@server/api/externalapi';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaRequestManifest, {
  MangaRequestBindingState,
  MangaRequestScope,
} from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  QuotaRestrictedError,
  RequestPermissionError,
  ServiceConfigurationError,
} from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { User } from '@server/entity/User';
import type { MediaRequestBody } from '@server/interfaces/api/requestInterfaces';
import {
  createMangaMedia,
  findMangaMedia,
  newMangaMediaTally,
  reconcileMangaMedia,
} from '@server/lib/mangaMedia';
import {
  MangaCatalogUnavailableError,
  MangaRequestNotFoundError,
  MangaRequestScopeError,
} from '@server/lib/mangaRequests';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import requestDispatchManager from '@server/lib/requestDispatch';
import { getSettings, type SuwayomiSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import type { QueryRunner } from 'typeorm';

setupTestDb();

const TITLE = 900001;
const { AWAITING_BINDING, BOUND } = MangaRequestBindingState;

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

let savedSuwayomi: SuwayomiSettings[];
let catalog: Map<number, AnilistMangaDetails | null | Error>;
let anilistCalls: number[];
let externalCalls: string[];
let notifications: Notification[];
let enqueued: number[];
let dispatches: number;

beforeEach(() => {
  const settings = getSettings();
  savedSuwayomi = settings.suwayomi;
  settings.suwayomi = [suwayomi(1, true), suwayomi(2)];

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
  externalCalls = [];
  mock.method(
    ExternalAPI.prototype as unknown as {
      get: (endpoint: string) => Promise<unknown>;
    },
    'get',
    async (endpoint: string) => {
      externalCalls.push(endpoint);
      throw new Error(`Unstubbed external endpoint: ${endpoint}`);
    }
  );
  notifications = [];
  mock.method(
    notificationManager,
    'sendNotificationIntent',
    async (type: Notification) => {
      notifications.push(type);
    }
  );
  enqueued = [];
  const enqueue = requestDispatchManager.enqueue.bind(requestDispatchManager);
  mock.method(
    requestDispatchManager,
    'enqueue',
    async (requestId: number, queryRunner?: QueryRunner) => {
      enqueued.push(requestId);
      return enqueue(requestId, queryRunner);
    }
  );
  dispatches = 0;
  mock.method(
    MediaRequestSubscriber.prototype,
    'dispatchRequestById',
    async () => {
      dispatches += 1;
      return { delivered: true };
    }
  );
});

afterEach(async () => {
  await waitForBackgroundTasks();
  getSettings().suwayomi = savedSuwayomi;
  mock.restoreAll();
});

const createUser = (
  email: string,
  permissions: number,
  init: Partial<User> = {}
): Promise<User> =>
  getRepository(User).save(
    new User({ email, permissions, avatar: '', ...init })
  );

const requester = () => createUser('manga@seerr.dev', Permission.REQUEST_MANGA);

const admin = () =>
  getRepository(User).findOneOrFail({ where: { email: 'admin@seerr.dev' } });

const requestManga = (
  user: User,
  body: Partial<MediaRequestBody> = {}
): Promise<MediaRequest> =>
  MediaRequest.request(
    { mediaId: TITLE, mediaType: MediaType.MANGA, ...body },
    user
  );

const seedBinding = (
  anilistId: number,
  instanceId: number,
  availability = MediaStatus.UNKNOWN
) =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId,
      sourceId: '1000',
      url: `/manga/${anilistId}-${instanceId}`,
      urlHash: hashMangaSourceUrl(`/manga/${anilistId}-${instanceId}`),
      anilistId,
      suwayomiMangaId: 1,
      title: 'Sample Manga',
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state: MangaBindingState.ACTIVE,
      inLibrary: true,
      availability,
    })
  );

const manifestOf = (request: MediaRequest) =>
  getRepository(MangaRequestManifest).findOneByOrFail({
    requestId: request.id,
  });

const reload = (request: MediaRequest) =>
  getRepository(MediaRequest).findOneOrFail({ where: { id: request.id } });

const assertHeld = async () => {
  await waitForBackgroundTasks();
  assert.deepStrictEqual(enqueued, []);
  assert.strictEqual(dispatches, 0);
  assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
};

const assertNothingWritten = async () => {
  assert.strictEqual(await getRepository(MediaRequest).count(), 0);
  assert.strictEqual(await getRepository(Media).count(), 0);
  assert.strictEqual(await getRepository(MangaRequestManifest).count(), 0);
};

describe('manga requests', () => {
  it('parks a pending request until its title is bound on the target instance', async () => {
    const request = await requestManga(await requester());

    assert.strictEqual(request.type, MediaType.MANGA);
    assert.strictEqual(request.status, MediaRequestStatus.PENDING);
    assert.strictEqual(request.is4k, false);
    assert.strictEqual(request.serverId, 1);
    assert.deepStrictEqual(
      request.serviceTargets?.map(({ serviceType, format, serverId }) => ({
        serviceType,
        format,
        serverId,
      })),
      [{ serviceType: 'suwayomi', format: 'manga', serverId: 1 }]
    );
    const media = (await findMangaMedia(dataSource.manager, [TITLE])).get(
      TITLE
    );
    assert.strictEqual(media?.id, request.media.id);
    assert.strictEqual(media?.status, MediaStatus.PENDING);

    const manifest = await manifestOf(request);
    assert.strictEqual(manifest.anilistId, TITLE);
    assert.strictEqual(manifest.instanceId, 1);
    assert.strictEqual(manifest.scope, MangaRequestScope.ALL_AT_DISPATCH);
    assert.strictEqual(manifest.bindingState, AWAITING_BINDING);
    assert.strictEqual(manifest.boundAt, null);
    assert.strictEqual(manifest.checkpoint, null);
    assert.strictEqual(manifest.frozenAt, null);

    assert.deepStrictEqual(anilistCalls, [TITLE]);
    assert.deepStrictEqual(externalCalls, []);
    assert.deepStrictEqual(notifications, [Notification.MEDIA_PENDING]);
    await assertHeld();
  });

  it('records the request bound when the binding exists first', async () => {
    await seedBinding(TITLE, 1);
    await seedBinding(TITLE + 1, 2);
    const user = await requester();

    const bound = await requestManga(user);
    const elsewhere = await requestManga(user, { mediaId: TITLE + 1 });

    const manifest = await manifestOf(bound);
    assert.strictEqual(manifest.bindingState, BOUND);
    assert.ok(manifest.boundAt instanceof Date);
    // Its only binding is on another instance.
    assert.strictEqual(
      (await manifestOf(elsewhere)).bindingState,
      AWAITING_BINDING
    );
    await assertHeld();
  });

  it('releases a parked request when a library scan binds its title, without approving it', async () => {
    const request = await requestManga(await requester());
    assert.strictEqual(
      (await manifestOf(request)).bindingState,
      AWAITING_BINDING
    );

    await seedBinding(TITLE, 1, MediaStatus.AVAILABLE);
    await reconcileMangaMedia([TITLE], {
      completedInstanceIds: new Set([1]),
      tally: newMangaMediaTally(),
    });

    const manifest = await manifestOf(request);
    assert.strictEqual(manifest.bindingState, BOUND);
    assert.ok(manifest.boundAt instanceof Date);
    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: request.media.id }))
        .status,
      MediaStatus.AVAILABLE
    );
    assert.strictEqual(
      (await reload(request)).status,
      MediaRequestStatus.PENDING
    );
    assert.ok(!notifications.includes(Notification.MEDIA_AVAILABLE));
    await assertHeld();
  });

  it('holds auto-approved requests out of dispatch, bound or not', async () => {
    await seedBinding(TITLE + 1, 1);
    const user = await createUser(
      'auto@seerr.dev',
      Permission.REQUEST_MANGA + Permission.AUTO_APPROVE_MANGA
    );

    const parked = await requestManga(user);
    const bound = await requestManga(user, { mediaId: TITLE + 1 });

    for (const request of [parked, bound]) {
      assert.strictEqual(request.status, MediaRequestStatus.APPROVED);
      assert.strictEqual(request.modifiedBy?.id, user.id);
    }
    assert.strictEqual(
      (await manifestOf(parked)).bindingState,
      AWAITING_BINDING
    );
    assert.strictEqual((await manifestOf(bound)).bindingState, BOUND);
    assert.deepStrictEqual(notifications, [
      Notification.MEDIA_AUTO_APPROVED,
      Notification.MEDIA_AUTO_APPROVED,
    ]);
    await assertHeld();
  });

  it('holds a request an admin approves, while a movie still enqueues', async () => {
    await seedBinding(TITLE, 1);
    const request = await requestManga(await requester());
    const approver = await admin();

    const pending = await reload(request);
    pending.status = MediaRequestStatus.APPROVED;
    pending.modifiedBy = approver;
    await getRepository(MediaRequest).save(pending);

    assert.strictEqual(
      (await reload(request)).status,
      MediaRequestStatus.APPROVED
    );
    assert.deepStrictEqual(notifications, [
      Notification.MEDIA_PENDING,
      Notification.MEDIA_APPROVED,
    ]);
    await assertHeld();

    const movie = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media: await getRepository(Media).save(
          new Media({
            tmdbId: 77_001,
            mediaType: MediaType.MOVIE,
            status: MediaStatus.PENDING,
            status4k: MediaStatus.UNKNOWN,
          })
        ),
        requestedBy: approver,
        is4k: false,
      })
    );
    await waitForBackgroundTasks();
    assert.deepStrictEqual(enqueued, [movie.id]);
  });

  it('refuses adult, novel and unknown titles before writing any row', async () => {
    catalog.set(900002, details({ id: 900002, isAdult: true }));
    catalog.set(900003, details({ id: 900003, format: 'NOVEL' }));
    catalog.set(900004, null);
    const user = await requester();

    for (const mediaId of [900002, 900003, 900004]) {
      await assert.rejects(
        () => requestManga(user, { mediaId }),
        MangaRequestNotFoundError
      );
    }

    assert.deepStrictEqual(anilistCalls, [900002, 900003, 900004]);
    await assertNothingWritten();
    await assertHeld();
  });

  it('reports an AniList failure as the catalog being unavailable', async () => {
    const limited = new AnilistRateLimitedError(30);
    catalog.set(TITLE, limited);
    const user = await requester();

    await assert.rejects(
      () => requestManga(user),
      (error: unknown) =>
        error instanceof MangaCatalogUnavailableError &&
        error.failure === limited
    );
    await assertNothingWritten();
  });

  it('refuses every manga request when no Suwayomi server is configured', async () => {
    getSettings().suwayomi = [];
    const user = await requester();

    await assert.rejects(
      () => requestManga(user),
      (error: unknown) =>
        error instanceof ServiceConfigurationError &&
        error.message === 'No Suwayomi server is configured for manga requests.'
    );
    assert.deepStrictEqual(anilistCalls, []);
    await assertNothingWritten();
  });

  it('targets the default instance unless an advanced requester picks one', async () => {
    getSettings().suwayomi = [suwayomi(1), suwayomi(2, true)];
    const approver = await admin();

    const plain = await requestManga(await requester(), { serverId: 1 });
    const picked = await requestManga(approver, {
      mediaId: TITLE + 1,
      serverId: 1,
    });

    assert.strictEqual(plain.serverId, 2);
    assert.strictEqual((await manifestOf(plain)).instanceId, 2);
    assert.strictEqual(picked.serverId, 1);
    assert.strictEqual((await manifestOf(picked)).instanceId, 1);
    await assert.rejects(
      () => requestManga(approver, { mediaId: TITLE + 2, serverId: 9 }),
      (error: unknown) =>
        error instanceof ServiceConfigurationError &&
        error.message === 'Selected Suwayomi server does not exist.'
    );
  });

  it('admits only one of two concurrent requests for a title', async () => {
    const first = await requester();
    const second = await createUser('second@seerr.dev', Permission.REQUEST);

    const results = await Promise.allSettled(
      [first, second].map((user) => requestManga(user))
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(
      rejected[0].reason.message,
      'A request for this manga already exists.'
    );
    assert.strictEqual(await getRepository(MediaRequest).count(), 1);
    assert.strictEqual(await getRepository(MangaRequestManifest).count(), 1);
    assert.strictEqual(await getRepository(Media).count(), 1);
  });

  it('lets an approver promote a pending request instead of duplicating it', async () => {
    const pending = await requestManga(await requester());

    const promoted = await requestManga(await admin());

    assert.strictEqual(promoted.id, pending.id);
    assert.strictEqual(promoted.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(await getRepository(MediaRequest).count(), 1);
    assert.strictEqual(await getRepository(MangaRequestManifest).count(), 1);
    await assertHeld();
  });

  it('refuses blocklisted and available titles', async () => {
    await dataSource.transaction(async (manager) => {
      await createMangaMedia(manager, TITLE, MediaStatus.BLOCKLISTED);
      await createMangaMedia(manager, TITLE + 1, MediaStatus.AVAILABLE);
    });
    const user = await requester();

    await assert.rejects(() => requestManga(user), BlocklistedMediaError);
    await assert.rejects(
      () => requestManga(user, { mediaId: TITLE + 1 }),
      (error: unknown) =>
        error instanceof DuplicateMediaRequestError &&
        error.message === 'This manga is already available.'
    );
    assert.strictEqual(await getRepository(MediaRequest).count(), 0);
  });

  it('counts manga requests against the manga quota', async () => {
    const user = await createUser('quota@seerr.dev', Permission.REQUEST_MANGA, {
      mangaQuotaLimit: 1,
      mangaQuotaDays: 7,
    });

    await requestManga(user);
    await assert.rejects(
      () => requestManga(user, { mediaId: TITLE + 1 }),
      (error: unknown) =>
        error instanceof QuotaRestrictedError &&
        error.message === 'Manga Quota exceeded.'
    );
    assert.strictEqual(await getRepository(MediaRequest).count(), 1);
  });

  it('requires a manga or general request permission', async () => {
    const user = await createUser('movies@seerr.dev', Permission.REQUEST_MOVIE);

    await assert.rejects(
      () => requestManga(user),
      (error: unknown) =>
        error instanceof RequestPermissionError &&
        error.message === 'You do not have permission to make manga requests.'
    );
    assert.deepStrictEqual(anilistCalls, []);
  });

  it('stores a valid chapter scope and refuses an invalid one', async () => {
    const user = await requester();

    for (const mangaScope of [
      { scope: 'LATEST_N', latestCount: 0 },
      { scope: 'RANGE', rangeStart: 5, rangeEnd: 2 },
      { scope: 'EVERYTHING' },
    ] as MediaRequestBody['mangaScope'][]) {
      await assert.rejects(
        () => requestManga(user, { mangaScope }),
        MangaRequestScopeError
      );
    }
    assert.deepStrictEqual(anilistCalls, []);
    await assertNothingWritten();

    const latest = await requestManga(user, {
      mangaScope: { scope: 'LATEST_N', latestCount: 5 },
    });
    const range = await requestManga(user, {
      mediaId: TITLE + 1,
      mangaScope: { scope: 'RANGE', rangeStart: 1.5, rangeEnd: 10 },
    });

    assert.deepStrictEqual(
      (({ scope, latestCount, rangeStart, rangeEnd }) => ({
        scope,
        latestCount,
        rangeStart,
        rangeEnd,
      }))(await manifestOf(latest)),
      {
        scope: MangaRequestScope.LATEST_N,
        latestCount: 5,
        rangeStart: null,
        rangeEnd: null,
      }
    );
    const ranged = await manifestOf(range);
    assert.strictEqual(ranged.scope, MangaRequestScope.RANGE);
    assert.strictEqual(ranged.rangeStart, 1.5);
    assert.strictEqual(ranged.rangeEnd, 10);
  });
});

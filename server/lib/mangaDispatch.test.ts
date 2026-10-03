import AnilistAPI from '@server/api/anilist';
import MangaDexAPI from '@server/api/mangadex';
import { SUWAYOMI_TRACKER_IDS } from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import {
  INSTANCE_MARKER_KEY,
  REQUEST_INDEX_PREFIX,
  REQUEST_STAMP_KEY,
} from '@server/api/suwayomi/operations';
import {
  MANGA_DISPATCH_WAIT_MS,
  MANGA_SOURCE_FETCH_ATTEMPTS,
  MangaDispatchError,
  MangaRequestBindingState,
  MangaRequestCheckpoint,
  MangaRequestScope,
} from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaInstanceMarker from '@server/entity/MangaInstanceMarker';
import MangaLibraryOwnership from '@server/entity/MangaLibraryOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MANGA_BINDING_ORIGIN_ADMIN,
  MANGA_BINDING_ORIGIN_RESOLVER,
  MANGA_MATCHED_BY_MANGADEX_LINK,
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import * as mediaRequestModule from '@server/entity/MediaRequest';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import * as mangaDispatch from '@server/lib/mangaDispatch';
import {
  MANGA_DISPATCH_SWEEP_LIMIT,
  MAX_MANGA_DISPATCH_SWEEP_LIMIT,
  dispatchMangaRequest,
  findDueMangaRequestIds,
} from '@server/lib/mangaDispatch';
import { syncMangaRequestBindings } from '@server/lib/mangaRequestBindings';
import {
  catchUpMangaResolverTitle,
  writeMangaResolverBinding,
} from '@server/lib/mangaResolver/bind';
import { findWaitingMangaTitles } from '@server/lib/mangaResolver/titles';
import * as mediaMutation from '@server/lib/mediaMutation';
import requestDispatchManager from '@server/lib/requestDispatch';
import { mangaLibraryScanner } from '@server/lib/scanners/manga/suwayomi';
import * as serviceAdmission from '@server/lib/serviceAdmission';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import * as instanceAdmission from '@server/lib/suwayomi/instanceAdmission';
import * as userSecurityMutation from '@server/lib/userSecurityMutation';
import logger from '@server/logger';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { graphqlErrors, syntheticFailure } from '@server/test/fakeSuwayomi';
import {
  FAKE_SOURCE_ID,
  FAKE_TITLE_PREFIX,
  FAKE_URL_PREFIX,
  assertAllowedDispatchTraffic,
  dispatchClientFor,
  dispatchInstanceFor,
  fakeChapterUrl,
  fakeDispatchChapters,
  fakeDispatchManga,
  fakeMangaUrl,
  loadDispatchRequest,
  seedDispatchBinding,
  seedDispatchRequest,
  startFakeDispatchSuwayomi,
  type FakeDispatchManga,
  type FakeDispatchSuwayomi,
} from '@server/test/fakeSuwayomiDispatch';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';

setupTestDb();

const {
  INSTANCE_MARKED,
  LIBRARY_ADDED,
  CATEGORY_READY,
  CHAPTERS_FETCHED,
  MANIFEST_FROZEN,
  CHAPTERS_ENQUEUED,
} = MangaRequestCheckpoint;
const { AWAITING_BINDING, BOUND } = MangaRequestBindingState;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A value no log line may ever carry. */
const MALFORMED = 'MALFORMED-SENTINEL';
const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const fakes: FakeDispatchSuwayomi[] = [];

type Level = 'error' | 'warn' | 'info' | 'debug';
type LogEntry = [Level, string, Record<string, unknown>];
let logs: LogEntry[] = [];

type Client = ReturnType<typeof dispatchClientFor>;
type ManifestValues = Partial<Omit<MangaRequestManifest, 'request'>>;

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

const captureLogs = (): LogEntry[] => {
  const captured: LogEntry[] = [];
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    mock.method(logger, level, (message: unknown, meta?: unknown) => {
      captured.push([
        level,
        String(message),
        (meta ?? {}) as Record<string, unknown>,
      ]);
      return logger;
    });
  }
  return captured;
};

/** The level and metadata of every log line with `message`. */
const logged = (message: string) =>
  logs
    .filter(([, text]) => text === message)
    .map(([level, , meta]) => [level, meta] as const);

const start = async (...mangas: FakeDispatchManga[]) => {
  const fake = await startFakeDispatchSuwayomi(mangas);
  fakes.push(fake);
  return fake;
};

const manifestOf = (requestId: number) =>
  getRepository(MangaRequestManifest).findOneByOrFail({ requestId });

const setManifest = (requestId: number, values: ManifestValues) =>
  getRepository(MangaRequestManifest).update({ requestId }, values);

/** Runs one dispatch of the request with a short-timeout client of `fake`. */
const run = async (
  requestId: number,
  fake: FakeDispatchSuwayomi,
  client: Client = dispatchClientFor(fake.server)
) =>
  dispatchMangaRequest(await loadDispatchRequest(requestId), {
    clientFor: () => client,
  });

/**
 * A fake serving `mangas`, instance 1 pointing at it, a binding of AniList
 * 9001 to the first manga and an approved request for that title.
 */
const setup = async (
  mangas: FakeDispatchManga[] = [fakeDispatchManga(11)],
  {
    binding = {},
    request = {},
  }: {
    binding?: Partial<MangaSourceBinding>;
    request?: Parameters<typeof seedDispatchRequest>[0];
  } = {}
) => {
  const fake = await start(...mangas);
  configure(dispatchInstanceFor(fake.server));
  const seededBinding = await seedDispatchBinding(mangas[0], binding);
  const seeded = await seedDispatchRequest(request);
  return {
    fake,
    binding: seededBinding,
    requestId: seeded.request.id,
    media: seeded.media,
  };
};

const assertWaits = (
  manifest: MangaRequestManifest,
  waitMs: number,
  startedAt: number
) => {
  assert.ok(manifest.retryNotBefore instanceof Date);
  const delay = manifest.retryNotBefore.getTime() - startedAt;
  assert.ok(
    delay >= waitMs - 5_000 && delay <= waitMs + 60_000,
    `waits ${delay} ms instead of ${waitMs} ms`
  );
};

const libraryOwnership = async () =>
  (
    await getRepository(MangaLibraryOwnership).find({ order: { id: 'ASC' } })
  ).map(({ instanceId, sourceId, urlHash, url, addedBySeerrng }) => {
    assert.strictEqual(urlHash, hashMangaSourceUrl(url));
    return [instanceId, sourceId, url, addedBySeerrng];
  });

const ownedChapterUrls = async () =>
  (
    await getRepository(MangaChapterOwnership).find({ order: { id: 'ASC' } })
  ).map(({ chapterUrl }) => chapterUrl);

const frozenChapterUrls = async (requestId: number) => {
  const { id } = await manifestOf(requestId);
  return (
    await getRepository(MangaRequestChapter).find({
      where: { manifestId: id },
      order: { id: 'ASC' },
    })
  ).map(({ url }) => url);
};

const chapterUrls = (mangaId: number, ...numbers: number[]) =>
  numbers.map((chapterNumber) => fakeChapterUrl(mangaId, chapterNumber));

const chapterIds = (mangaId: number, ...numbers: number[]) =>
  numbers.map((chapterNumber) => mangaId * 100 + chapterNumber);

const range = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index);

const mediaStatusOf = async (id: number) =>
  (await getRepository(Media).findOneByOrFail({ id })).status;

const stampOf = (requestIds: number[], addedBySeerrng = true) => ({
  v: 1,
  requestIds: [...requestIds].sort((a, b) => a - b),
  addedBySeerrng,
  anilistId: 9001,
});

const ownMarker = async (instanceId = 1) =>
  (await getRepository(MangaInstanceMarker).findOneBy({ instanceId }))?.marker;

const saveMarker = (instanceId: number, marker = randomUUID()) =>
  getRepository(MangaInstanceMarker).save(
    new MangaInstanceMarker({ instanceId, marker })
  );

const rejectBinding = (binding: MangaSourceBinding) =>
  getRepository(MangaSourceBinding).update(binding.id, {
    state: MangaBindingState.REJECTED,
  });

/**
 * Records how many request and instance admissions were open each time a
 * dispatch was queued.
 */
const admissionsAtEnqueue = (): number[] => {
  let open = 0;
  const track =
    <Args extends unknown[], Result>(
      admit: (...args: Args) => Promise<Result>
    ) =>
    async (...args: Args): Promise<Result> => {
      open += 1;
      try {
        return await admit(...args);
      } finally {
        open -= 1;
      }
    };
  mock.method(
    mediaRequestModule,
    'runWithRequestAdmission',
    track(mediaRequestModule.runWithRequestAdmission)
  );
  mock.method(
    instanceAdmission,
    'runWithSuwayomiInstanceAdmission',
    track(instanceAdmission.runWithSuwayomiInstanceAdmission)
  );
  const seen: number[] = [];
  const enqueue = requestDispatchManager.enqueue.bind(requestDispatchManager);
  mock.method(
    requestDispatchManager,
    'enqueue',
    (...args: Parameters<typeof enqueue>) => {
      seen.push(open);
      return enqueue(...args);
    }
  );
  return seen;
};

/** Stubs the library scan's AniList and MangaDex lookups: nothing matches. */
const stubScanLookups = () => {
  mock.method(AnilistAPI.prototype, 'getMangaIdsByMalIds', async () => ({
    hasNextPage: false,
    links: [],
  }));
  mock.method(
    MangaDexAPI.prototype,
    'getAniListLinks',
    async (uuids: readonly string[]) =>
      new Map(uuids.map((value) => [value, null]))
  );
  mock.method(AnilistAPI.prototype, 'searchMangaTitles', async () => []);
};

/** Log lines name codes, counts and IDs: never a URL, title, stamp or marker. */
const assertPrivateLogs = async () => {
  const text = inspect(logs, {
    depth: 12,
    maxArrayLength: null,
    maxStringLength: null,
  });
  const markers = [
    ...(await getRepository(MangaInstanceMarker).find()).map(
      ({ marker }) => marker
    ),
    ...fakes.flatMap((fake) => {
      const marker = fake.state.globalMeta.get(INSTANCE_MARKER_KEY);
      return marker ? [marker] : [];
    }),
  ];
  for (const secret of [
    FAKE_URL_PREFIX,
    FAKE_TITLE_PREFIX,
    '"requestIds"',
    'addedBySeerrng',
    MALFORMED,
    'com.example',
    ...markers,
  ]) {
    assert.ok(!text.includes(secret), `A log line carried ${secret}`);
  }
};

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  configure();
  logs = captureLogs();
});

afterEach(async () => {
  try {
    await waitForBackgroundTasks();
    for (const fake of fakes) {
      assertAllowedDispatchTraffic(fake.server);
    }
    await assertPrivateLogs();
  } finally {
    mock.restoreAll();
    settings.main.enabledMediaCategories = categories;
    configure();
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

describe('manga dispatch: a fresh request', () => {
  it('runs every step once and records what SeerrNG owns', async () => {
    const { fake, requestId, media } = await setup();

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    const manifest = await manifestOf(requestId);
    assert.strictEqual(manifest.checkpoint, CHAPTERS_ENQUEUED);
    assert.ok(manifest.checkpointAt instanceof Date);
    assert.ok(manifest.frozenAt instanceof Date);
    assert.deepStrictEqual(
      [
        manifest.bindingState,
        manifest.bindingSourceId,
        manifest.bindingUrlHash,
        manifest.suwayomiMangaId,
        manifest.attempts,
        manifest.lastError,
        manifest.retryNotBefore,
      ],
      [
        BOUND,
        FAKE_SOURCE_ID,
        hashMangaSourceUrl(fakeMangaUrl(11)),
        11,
        0,
        null,
        null,
      ]
    );

    const markers = await getRepository(MangaInstanceMarker).find();
    assert.deepStrictEqual(
      markers.map(({ instanceId }) => instanceId),
      [1]
    );
    assert.match(markers[0].marker, UUID_V4);
    assert.strictEqual(
      fake.state.globalMeta.get(INSTANCE_MARKER_KEY),
      markers[0].marker
    );

    assert.strictEqual(fake.manga(11).inLibrary, true);
    assert.deepStrictEqual(await libraryOwnership(), [
      [1, FAKE_SOURCE_ID, fakeMangaUrl(11), true],
    ]);
    assert.deepStrictEqual(fake.state.categories, [{ id: 1, name: 'SeerrNG' }]);
    assert.deepStrictEqual(fake.manga(11).categoryIds, [1]);
    assert.deepStrictEqual(fake.indexEntry(requestId), {
      sourceId: FAKE_SOURCE_ID,
      url: fakeMangaUrl(11),
      mangaId: 11,
    });
    assert.deepStrictEqual(fake.stamp(11), stampOf([requestId]));

    assert.deepStrictEqual(
      await frozenChapterUrls(requestId),
      chapterUrls(11, 1, 2, 3)
    );
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 1, 2, 3));
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
    assert.strictEqual(fake.state.downloader, 'STOPPED');

    assert.strictEqual(await mediaStatusOf(media.id), MediaStatus.PROCESSING);
    assert.strictEqual(
      (await loadDispatchRequest(requestId)).status,
      MediaRequestStatus.APPROVED
    );
    assert.deepStrictEqual(
      fake.server
        .operations('FetchMangaAndChapters')
        .map(({ variables }) => variables.fetchManga),
      [false]
    );
    assert.deepStrictEqual(
      fake.writes().map(({ operationName }) => operationName),
      [
        'SetInstanceMarker',
        'SetInLibrary',
        'CreateCategory',
        'AddMangaToCategory',
        'SetRequestIndex',
        'SetRequestStamp',
        'EnqueueChapters',
      ]
    );
  });

  it('sends nothing once the chapters are queued', async () => {
    const { fake, requestId } = await setup();
    await run(requestId, fake);
    const sent = fake.server.requests.length;
    const before = await manifestOf(requestId);

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.strictEqual(fake.server.requests.length, sent);
    assert.deepStrictEqual(await manifestOf(requestId), before);
  });

  it('replays from INSTANCE_MARKED without writing anything twice', async () => {
    const { fake, requestId } = await setup();
    await run(requestId, fake);
    await setManifest(requestId, { checkpoint: INSTANCE_MARKED });
    const sent = fake.server.requests.length;

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
    const replayed = fake.server.requests
      .slice(sent)
      .map(({ operationName }) => operationName);
    for (const write of [
      'SetInstanceMarker',
      'SetInLibrary',
      'CreateCategory',
      'SetRequestStamp',
      'EnqueueChapters',
    ]) {
      assert.ok(!replayed.includes(write), `The replay sent ${write}`);
    }
    assert.deepStrictEqual(fake.state.categories, [{ id: 1, name: 'SeerrNG' }]);
    assert.deepStrictEqual(fake.manga(11).categoryIds, [1]);
    assert.deepStrictEqual(fake.enqueuedIds(), chapterIds(11, 1, 2, 3));
    assert.deepStrictEqual(await libraryOwnership(), [
      [1, FAKE_SOURCE_ID, fakeMangaUrl(11), true],
    ]);
    assert.deepStrictEqual(fake.stamp(11), stampOf([requestId]));
  });

  it('queues each chapter once when two requests for a title run together', async () => {
    const { fake, requestId: first, media } = await setup();
    const { request } = await seedDispatchRequest({ media });
    const client = dispatchClientFor(fake.server);

    assert.deepStrictEqual(
      await Promise.all([
        run(first, fake, client),
        run(request.id, fake, client),
      ]),
      [{ delivered: true }, { delivered: true }]
    );

    for (const requestId of [first, request.id]) {
      assert.strictEqual(
        (await manifestOf(requestId)).checkpoint,
        CHAPTERS_ENQUEUED
      );
    }
    assert.deepStrictEqual(
      [...fake.enqueuedIds()].sort((a, b) => a - b),
      chapterIds(11, 1, 2, 3)
    );
    assert.strictEqual(fake.server.operations('SetInstanceMarker').length, 1);
    assert.strictEqual(fake.server.operations('CreateCategory').length, 1);
    assert.strictEqual(await getRepository(MangaInstanceMarker).count(), 1);
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 1, 2, 3));
    assert.deepStrictEqual(fake.stamp(11), stampOf([first, request.id]));
  });

  it('reaches Suwayomi through the outbox once an admin approves it', async () => {
    const { fake, requestId } = await setup(undefined, {
      request: { status: MediaRequestStatus.PENDING },
    });
    const request = await loadDispatchRequest(requestId);
    request.status = MediaRequestStatus.APPROVED;

    await getRepository(MediaRequest).save(request);
    await waitForBackgroundTasks();

    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });
});

describe('manga dispatch: restarts', () => {
  /** Each write, and whether the run that hit it recovers by itself. */
  const writes: [string, boolean][] = [
    ['SetInstanceMarker', false],
    ['SetInLibrary', false],
    // findOrCreateCategory reads the category back after a failed create.
    ['CreateCategory', true],
    ['AddMangaToCategory', false],
    ['SetRequestIndex', false],
    ['SetRequestStamp', false],
    ['EnqueueChapters', false],
  ];

  for (const [operation, recovers] of writes) {
    it(`converges when ${operation} applied but its answer failed`, async () => {
      const { fake, requestId } = await setup();
      fake.fault(operation, 'applied-error');

      const first = await run(requestId, fake);

      if (recovers) {
        assert.deepStrictEqual(first, { delivered: true });
      } else {
        assert.deepStrictEqual(first, { delivered: false });
        const stopped = await manifestOf(requestId);
        assert.deepStrictEqual(
          [stopped.lastError, stopped.attempts, stopped.retryNotBefore],
          [MangaDispatchError.SUWAYOMI_UNAVAILABLE, 1, null]
        );
        assert.notStrictEqual(stopped.checkpoint, CHAPTERS_ENQUEUED);
        assert.deepStrictEqual(await run(requestId, fake), { delivered: true });
      }

      const manifest = await manifestOf(requestId);
      assert.deepStrictEqual(
        [manifest.checkpoint, manifest.attempts, manifest.lastError],
        [CHAPTERS_ENQUEUED, 0, null]
      );
      assert.strictEqual(
        fake.state.globalMeta.get(INSTANCE_MARKER_KEY),
        await ownMarker()
      );
      assert.strictEqual(fake.manga(11).inLibrary, true);
      assert.deepStrictEqual(await libraryOwnership(), [
        [1, FAKE_SOURCE_ID, fakeMangaUrl(11), true],
      ]);
      assert.deepStrictEqual(fake.state.categories, [
        { id: 1, name: 'SeerrNG' },
      ]);
      assert.deepStrictEqual(fake.manga(11).categoryIds, [1]);
      assert.deepStrictEqual(fake.indexEntry(requestId), {
        sourceId: FAKE_SOURCE_ID,
        url: fakeMangaUrl(11),
        mangaId: 11,
      });
      assert.deepStrictEqual(fake.stamp(11), stampOf([requestId]));
      assert.deepStrictEqual(fake.enqueuedIds(), chapterIds(11, 1, 2, 3));
      assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
      assert.deepStrictEqual(
        await ownedChapterUrls(),
        chapterUrls(11, 1, 2, 3)
      );
    });
  }
});

describe('manga dispatch: bindings', () => {
  /** A request at CATEGORY_READY whose bound manga Suwayomi no longer has. */
  const setupGone = async () => {
    const fake = await start();
    const snapshot = dispatchInstanceFor(fake.server);
    configure(snapshot);
    const binding = await seedDispatchBinding(fakeDispatchManga(11));
    const { marker } = await saveMarker(1);
    fake.state.globalMeta.set(INSTANCE_MARKER_KEY, marker);
    const { request } = await seedDispatchRequest({
      manifest: { checkpoint: CATEGORY_READY, attempts: 2 },
    });
    return { fake, snapshot, binding, requestId: request.id };
  };

  it('waits, still bound, when its manga is gone, so no sync parks or queues it', async () => {
    const { fake, snapshot, requestId } = await setupGone();
    const startedAt = Date.now();

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [
        manifest.bindingState,
        manifest.checkpoint,
        manifest.checkpointAt,
        manifest.lastError,
        manifest.attempts,
      ],
      [BOUND, null, null, MangaDispatchError.BINDING_MISSING, 0]
    );
    assertWaits(manifest, MANGA_DISPATCH_WAIT_MS.binding, startedAt);
    assert.deepStrictEqual(fake.operationNames(), [
      'ByNaturalKey',
      'InstanceMarker',
    ]);
    assert.deepStrictEqual(fake.writes(), []);
    assert.deepStrictEqual(logged('Manga request dispatch is waiting'), [
      [
        'info',
        {
          label: 'Manga Dispatch',
          requestId,
          code: MangaDispatchError.BINDING_MISSING,
        },
      ],
    ]);

    // The binding is still ACTIVE: a parked request would be bound again.
    const enqueued = admissionsAtEnqueue();
    assert.deepStrictEqual(
      await syncMangaRequestBindings(dataSource.manager),
      []
    );
    await catchUpMangaResolverTitle(snapshot, 9001);
    await waitForBackgroundTasks();
    assert.deepStrictEqual(
      await findWaitingMangaTitles(dataSource.manager),
      []
    );
    assert.deepStrictEqual(enqueued, []);
    assert.deepStrictEqual(await manifestOf(requestId), manifest);
  });

  it('leaves a waiting request to the sweep until its wait is over', async () => {
    const { fake, requestId } = await setupGone();
    await run(requestId, fake);

    assert.deepStrictEqual(await findDueMangaRequestIds(50), []);

    await setManifest(requestId, {
      retryNotBefore: new Date(Date.now() - 1_000),
    });
    assert.deepStrictEqual(await findDueMangaRequestIds(50), [requestId]);
  });

  it('parks a waiting request once its title has no binding left, so the resolver looks again', async () => {
    const { fake, binding, requestId } = await setupGone();
    await run(requestId, fake);
    assert.strictEqual((await manifestOf(requestId)).bindingState, BOUND);
    await rejectBinding(binding);

    assert.deepStrictEqual(
      await syncMangaRequestBindings(dataSource.manager),
      []
    );

    assert.strictEqual(
      (await manifestOf(requestId)).bindingState,
      AWAITING_BINDING
    );
    assert.deepStrictEqual(
      (await findWaitingMangaTitles(dataSource.manager)).map(
        ({ anilistId, requestId: oldest, waiting }) => [
          anilistId,
          oldest,
          waiting,
        ]
      ),
      [[9001, requestId, true]]
    );
  });

  for (const [change, values] of [
    ['parked', { bindingState: AWAITING_BINDING, boundAt: null }],
    ['frozen', { checkpoint: MANIFEST_FROZEN, frozenAt: new Date() }],
  ] as const) {
    it(`writes nothing when its manga is gone but the request was ${change} meanwhile`, async () => {
      const { fake, requestId } = await setupGone();
      const client = dispatchClientFor(fake.server);
      const readMarker = client.getInstanceMarker.bind(client);
      let changed: MangaRequestManifest | undefined;
      mock.method(
        client,
        'getInstanceMarker',
        async (...args: Parameters<typeof readMarker>) => {
          if (!changed) {
            await setManifest(requestId, values);
            changed = await manifestOf(requestId);
          }
          return readMarker(...args);
        }
      );

      assert.deepStrictEqual(await run(requestId, fake, client), {
        delivered: true,
      });

      assert.ok(changed);
      assert.deepStrictEqual(await manifestOf(requestId), changed);
      assert.deepStrictEqual(logged('Manga request dispatch is waiting'), []);
    });
  }

  it('runs every step again once Suwayomi has its manga back under a new ID', async () => {
    const { fake, requestId } = await setup();
    fake.fault('FetchMangaAndChapters', 'error');
    assert.deepStrictEqual(await run(requestId, fake), { delivered: false });
    fake.state.mangas.splice(0);
    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });
    const waiting = await manifestOf(requestId);
    assert.deepStrictEqual(
      [waiting.bindingState, waiting.checkpoint, waiting.lastError],
      [BOUND, null, MangaDispatchError.BINDING_MISSING]
    );
    fake.state.mangas.push(
      fakeDispatchManga(12, {
        url: fakeMangaUrl(11),
        chapters: fakeDispatchChapters(11, [1, 2, 3]).map((chapter) => ({
          ...chapter,
          id: chapter.id + 100,
        })),
      })
    );

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [manifest.suwayomiMangaId, manifest.checkpoint, manifest.lastError],
      [12, CHAPTERS_ENQUEUED, null]
    );
    assert.deepStrictEqual(
      [fake.manga(12).inLibrary, fake.manga(12).categoryIds],
      [true, [1]]
    );
    assert.deepStrictEqual(fake.stamp(12), stampOf([requestId]));
    assert.deepStrictEqual(fake.indexEntry(requestId), {
      sourceId: FAKE_SOURCE_ID,
      url: fakeMangaUrl(11),
      mangaId: 12,
    });
    assert.deepStrictEqual(
      await frozenChapterUrls(requestId),
      chapterUrls(11, 1, 2, 3)
    );
    assert.deepStrictEqual(fake.state.queue, chapterIds(12, 1, 2, 3));
  });

  it('parks a request whose title has no binding left and drops it from the outbox, without a call', async () => {
    const fake = await start(fakeDispatchManga(11));
    configure(dispatchInstanceFor(fake.server));
    const { request } = await seedDispatchRequest();

    await requestDispatchManager.enqueue(request.id);
    await waitForBackgroundTasks();

    assert.strictEqual(
      (await manifestOf(request.id)).bindingState,
      AWAITING_BINDING
    );
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
    assert.deepStrictEqual(fake.server.requests, []);
    assert.deepStrictEqual(
      logged('Manga request parked until its title is bound again'),
      [
        [
          'info',
          {
            label: 'Manga Dispatch',
            requestId: request.id,
            code: MangaDispatchError.BINDING_MISSING,
          },
        ],
      ]
    );
  });

  it('waits instead of parking when a server marked for another instance lacks the manga', async () => {
    const fake = await start();
    configure(dispatchInstanceFor(fake.server));
    await seedDispatchBinding(fakeDispatchManga(11));
    await saveMarker(1);
    fake.state.globalMeta.set(INSTANCE_MARKER_KEY, randomUUID());
    const { request } = await seedDispatchRequest({
      manifest: { checkpoint: CATEGORY_READY },
    });
    const startedAt = Date.now();

    assert.deepStrictEqual(await run(request.id, fake), { delivered: true });

    const manifest = await manifestOf(request.id);
    assert.deepStrictEqual(
      [manifest.bindingState, manifest.checkpoint, manifest.lastError],
      [BOUND, CATEGORY_READY, MangaDispatchError.INSTANCE_MISMATCH]
    );
    assertWaits(manifest, MANGA_DISPATCH_WAIT_MS.attention, startedAt);
    assert.deepStrictEqual(fake.writes(), []);
    assert.deepStrictEqual(
      logged('Manga request parked until its title is bound again'),
      []
    );
  });

  it("adds a resolver binding's manga from outside the library", async () => {
    const { fake, requestId } = await setup(undefined, {
      binding: {
        origin: MANGA_BINDING_ORIGIN_RESOLVER,
        confidence: MangaBindingConfidence.HIGH,
        matchedBy: 'title',
        inLibrary: false,
      },
    });

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
    assert.strictEqual(fake.manga(11).inLibrary, true);
    assert.deepStrictEqual(await libraryOwnership(), [
      [1, FAKE_SOURCE_ID, fakeMangaUrl(11), true],
    ]);
  });

  it("tries a binding in the library first, then an admin's, then the oldest", async () => {
    const oldest = fakeDispatchManga(21);
    const admins = fakeDispatchManga(22);
    const inLibrary = fakeDispatchManga(23, { inLibrary: true });
    // Only the oldest still exists on the server.
    const fake = await start(oldest);
    configure(dispatchInstanceFor(fake.server));
    await seedDispatchBinding(oldest);
    await seedDispatchBinding(admins, {
      origin: MANGA_BINDING_ORIGIN_ADMIN,
      confidence: MangaBindingConfidence.MANUAL,
      matchedBy: 'manual',
    });
    await seedDispatchBinding(inLibrary);
    const { request } = await seedDispatchRequest();

    assert.deepStrictEqual(await run(request.id, fake), { delivered: true });

    assert.deepStrictEqual(
      fake.server
        .operations('ByNaturalKey')
        .map(({ variables }) => variables.url),
      [inLibrary.url, admins.url, oldest.url]
    );
    const manifest = await manifestOf(request.id);
    assert.deepStrictEqual(
      [manifest.bindingUrlHash, manifest.suwayomiMangaId, manifest.checkpoint],
      [hashMangaSourceUrl(oldest.url), 21, CHAPTERS_ENQUEUED]
    );
  });

  it('looks up at most five bindings per run', async () => {
    const fake = await start();
    configure(dispatchInstanceFor(fake.server));
    for (const id of range(31, 36)) {
      await seedDispatchBinding(fakeDispatchManga(id));
    }
    const { request } = await seedDispatchRequest();

    assert.deepStrictEqual(await run(request.id, fake), { delivered: true });

    assert.deepStrictEqual(
      fake.server
        .operations('ByNaturalKey')
        .map(({ variables }) => variables.url),
      range(31, 35).map((id) => fakeMangaUrl(id))
    );
    const manifest = await manifestOf(request.id);
    assert.deepStrictEqual(
      [manifest.bindingState, manifest.lastError],
      [BOUND, MangaDispatchError.BINDING_MISSING]
    );
  });

  it('after the freeze only looks up the binding it recorded', async () => {
    const recorded = fakeDispatchManga(21);
    const preferred = fakeDispatchManga(23, { inLibrary: true });
    const { fake, requestId } = await setup([recorded, preferred]);
    await run(requestId, fake);
    await seedDispatchBinding(preferred);
    await setManifest(requestId, { checkpoint: MANIFEST_FROZEN });
    const sent = fake.server.requests.length;

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.deepStrictEqual(
      fake.server.requests
        .slice(sent)
        .filter(({ operationName }) => operationName === 'ByNaturalKey')
        .map(({ variables }) => variables.url),
      [recorded.url]
    );
    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [manifest.bindingUrlHash, manifest.checkpoint],
      [hashMangaSourceUrl(recorded.url), CHAPTERS_ENQUEUED]
    );
  });

  it('moves an unfrozen request to another binding once an admin rejects its own', async () => {
    const first = fakeDispatchManga(21);
    const second = fakeDispatchManga(22);
    const { fake, requestId, binding } = await setup([first, second]);
    fake.fault('FetchMangaAndChapters', 'applied-error');
    assert.deepStrictEqual(await run(requestId, fake), { delivered: false });
    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CATEGORY_READY
    );

    await rejectBinding(binding);
    await seedDispatchBinding(second);

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [
        manifest.bindingUrlHash,
        manifest.suwayomiMangaId,
        manifest.checkpoint,
        manifest.attempts,
      ],
      [hashMangaSourceUrl(second.url), 22, CHAPTERS_ENQUEUED, 0]
    );
    assert.strictEqual(fake.manga(22).inLibrary, true);
    assert.deepStrictEqual(fake.indexEntry(requestId), {
      sourceId: FAKE_SOURCE_ID,
      url: second.url,
      mangaId: 22,
    });
    assert.deepStrictEqual(fake.state.queue, chapterIds(22, 1, 2, 3));
    assert.deepStrictEqual(
      await frozenChapterUrls(requestId),
      chapterUrls(22, 1, 2, 3)
    );
  });

  it('parks an unfrozen request whose only binding was rejected', async () => {
    const { fake, requestId, binding } = await setup();
    fake.fault('FetchMangaAndChapters', 'applied-error');
    await run(requestId, fake);
    await rejectBinding(binding);
    const sent = fake.server.requests.length;

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [manifest.bindingState, manifest.checkpoint, manifest.lastError],
      [AWAITING_BINDING, null, MangaDispatchError.BINDING_MISSING]
    );
    assert.strictEqual(fake.server.requests.length, sent);
  });

  it('waits an hour when a frozen request loses its binding', async () => {
    const { fake, requestId, binding } = await setup();
    fake.fault('EnqueueChapters', 'error');
    assert.deepStrictEqual(await run(requestId, fake), { delivered: false });
    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      MANIFEST_FROZEN
    );
    await rejectBinding(binding);
    const sent = fake.server.requests.length;
    const startedAt = Date.now();

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [
        manifest.bindingState,
        manifest.checkpoint,
        manifest.lastError,
        manifest.attempts,
      ],
      [BOUND, MANIFEST_FROZEN, MangaDispatchError.BINDING_MISSING, 1]
    );
    assertWaits(manifest, MANGA_DISPATCH_WAIT_MS.binding, startedAt);
    assert.strictEqual(fake.server.requests.length, sent);
  });

  it('leaves an enqueued request alone when its binding is rejected', async () => {
    const { fake, requestId, binding } = await setup();
    await run(requestId, fake);
    await rejectBinding(binding);
    const before = await manifestOf(requestId);
    const sent = fake.server.requests.length;

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.deepStrictEqual(await manifestOf(requestId), before);
    assert.strictEqual(fake.server.requests.length, sent);
  });

  it('waits for an admin when only unconfirmed bindings exist', async () => {
    const fake = await start(fakeDispatchManga(11));
    configure(dispatchInstanceFor(fake.server));
    await seedDispatchBinding(fake.manga(11), {
      confidence: MangaBindingConfidence.MEDIUM,
      matchedBy: 'title',
    });
    const { request } = await seedDispatchRequest();
    const startedAt = Date.now();

    assert.deepStrictEqual(await run(request.id, fake), { delivered: true });

    const manifest = await manifestOf(request.id);
    assert.deepStrictEqual(
      [
        manifest.bindingState,
        manifest.checkpoint,
        manifest.lastError,
        manifest.attempts,
      ],
      [BOUND, null, MangaDispatchError.BINDING_UNCONFIRMED, 0]
    );
    assertWaits(manifest, MANGA_DISPATCH_WAIT_MS.binding, startedAt);
    assert.deepStrictEqual(fake.server.requests, []);
    assert.deepStrictEqual(logged('Manga request dispatch is waiting'), [
      [
        'info',
        {
          label: 'Manga Dispatch',
          requestId: request.id,
          code: MangaDispatchError.BINDING_UNCONFIRMED,
        },
      ],
    ]);
  });

  it("dispatches an admin's binding at any confidence", async () => {
    const { fake, requestId } = await setup(undefined, {
      binding: {
        origin: MANGA_BINDING_ORIGIN_ADMIN,
        confidence: MangaBindingConfidence.LOW,
        matchedBy: 'manual',
      },
    });

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
  });

  it('keeps one binding row when a library scan sees the added manga', async () => {
    const manga = fakeDispatchManga(11, {
      trackRecords: [
        { trackerId: SUWAYOMI_TRACKER_IDS.aniList, remoteId: '9001' },
      ],
    });
    const { fake, requestId, binding } = await setup([manga], {
      binding: {
        origin: MANGA_BINDING_ORIGIN_RESOLVER,
        confidence: MangaBindingConfidence.HIGH,
        matchedBy: 'title',
      },
    });
    stubScanLookups();
    fake.fault('FindCategory', 'error');
    assert.deepStrictEqual(await run(requestId, fake), { delivered: false });
    assert.strictEqual((await manifestOf(requestId)).checkpoint, LIBRARY_ADDED);
    assert.strictEqual(fake.manga(11).inLibrary, true);

    await mangaLibraryScanner.run();

    assert.deepStrictEqual(
      (await getRepository(MangaSourceBinding).find()).map((row) => [
        row.id,
        row.state,
        row.inLibrary,
        row.origin,
      ]),
      [
        [
          binding.id,
          MangaBindingState.ACTIVE,
          true,
          MANGA_BINDING_ORIGIN_RESOLVER,
        ],
      ]
    );
    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });
    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
  });

  it('dispatches a parked request once a library scan binds its title', async () => {
    const fake = await start(
      fakeDispatchManga(11, {
        inLibrary: true,
        trackRecords: [
          { trackerId: SUWAYOMI_TRACKER_IDS.aniList, remoteId: '9001' },
        ],
      })
    );
    configure(dispatchInstanceFor(fake.server));
    const { request } = await seedDispatchRequest({
      manifest: { bindingState: AWAITING_BINDING, boundAt: null },
    });
    stubScanLookups();

    await mangaLibraryScanner.run();
    await waitForBackgroundTasks();

    const manifest = await manifestOf(request.id);
    assert.strictEqual(manifest.bindingState, BOUND);
    assert.strictEqual(manifest.checkpoint, CHAPTERS_ENQUEUED);
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('dispatches a parked request the end-of-scan sync binds when its instance scan failed', async () => {
    const manga = fakeDispatchManga(11);
    const fake = await start(manga);
    fake.server.onOperation('LibraryPage', graphqlErrors([syntheticFailure()]));
    configure(dispatchInstanceFor(fake.server));
    await seedDispatchBinding(manga, {
      origin: MANGA_BINDING_ORIGIN_RESOLVER,
      confidence: MangaBindingConfidence.HIGH,
      matchedBy: 'title',
    });
    const { request } = await seedDispatchRequest({
      manifest: { bindingState: AWAITING_BINDING, boundAt: null },
    });
    stubScanLookups();

    await mangaLibraryScanner.run();
    await waitForBackgroundTasks();

    const manifest = await manifestOf(request.id);
    assert.strictEqual(manifest.bindingState, BOUND);
    assert.strictEqual(manifest.checkpoint, CHAPTERS_ENQUEUED);
    assert.strictEqual(fake.manga(11).inLibrary, true);
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  for (const [action, bindTitle] of [
    [
      'binds',
      (snapshot: SuwayomiSettings, manga: FakeDispatchManga) =>
        writeMangaResolverBinding(
          {
            snapshot,
            anilistId: 9001,
            sourceId: manga.sourceId,
            url: manga.url,
            suwayomiMangaId: manga.id,
            title: manga.title,
            exact: true,
          },
          'auto'
        ),
    ],
    [
      'catches up',
      async (snapshot: SuwayomiSettings, manga: FakeDispatchManga) => {
        await seedDispatchBinding(manga, {
          origin: MANGA_BINDING_ORIGIN_RESOLVER,
          confidence: MangaBindingConfidence.EXACT_LINK,
          matchedBy: MANGA_MATCHED_BY_MANGADEX_LINK,
        });
        await catchUpMangaResolverTitle(snapshot, 9001);
      },
    ],
  ] as const) {
    it(`dispatches a parked request once the resolver ${action} its title, after its admissions close`, async () => {
      const manga = fakeDispatchManga(11);
      const fake = await start(manga);
      const snapshot = dispatchInstanceFor(fake.server);
      configure(snapshot);
      const { request } = await seedDispatchRequest({
        manifest: { bindingState: AWAITING_BINDING, boundAt: null },
      });
      const heldAtEnqueue = admissionsAtEnqueue();

      await bindTitle(snapshot, manga);
      await waitForBackgroundTasks();

      assert.deepStrictEqual(heldAtEnqueue, [0]);
      const manifest = await manifestOf(request.id);
      assert.strictEqual(manifest.bindingState, BOUND);
      assert.strictEqual(manifest.checkpoint, CHAPTERS_ENQUEUED);
      assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
    });
  }
});

describe('manga dispatch: instance markers', () => {
  it("stops without a write when the server carries another instance's marker", async () => {
    const { fake, requestId } = await setup();
    await saveMarker(1);
    fake.state.globalMeta.set(INSTANCE_MARKER_KEY, randomUUID());
    const startedAt = Date.now();

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [manifest.checkpoint, manifest.lastError, manifest.attempts],
      [null, MangaDispatchError.INSTANCE_MISMATCH, 0]
    );
    assertWaits(manifest, MANGA_DISPATCH_WAIT_MS.attention, startedAt);
    assert.deepStrictEqual(fake.writes(), []);
    assert.deepStrictEqual(logged('Manga request dispatch is waiting'), [
      [
        'warn',
        {
          label: 'Manga Dispatch',
          requestId,
          code: MangaDispatchError.INSTANCE_MISMATCH,
        },
      ],
    ]);
  });

  it('marks the server again when it lost the marker', async () => {
    const { fake, requestId } = await setup();
    const { marker } = await saveMarker(1);

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.strictEqual(fake.state.globalMeta.get(INSTANCE_MARKER_KEY), marker);
    assert.deepStrictEqual(
      fake.server
        .operations('SetInstanceMarker')
        .map(({ variables }) => variables.value),
      [marker]
    );
    assert.deepStrictEqual(
      (await getRepository(MangaInstanceMarker).find()).map((row) => [
        row.instanceId,
        row.marker,
      ]),
      [[1, marker]]
    );
    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
  });

  for (const [name, marker] of [
    ['is not a marker', 'not-a-marker'],
    ['no instance holds', randomUUID()],
  ] as const) {
    it(`stops when the unmarked instance meets a marker ${name}`, async () => {
      const { fake, requestId } = await setup();
      fake.state.globalMeta.set(INSTANCE_MARKER_KEY, marker);

      assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

      assert.strictEqual(
        (await manifestOf(requestId)).lastError,
        MangaDispatchError.INSTANCE_MISMATCH
      );
      assert.strictEqual(await getRepository(MangaInstanceMarker).count(), 0);
      assert.deepStrictEqual(fake.writes(), []);
    });
  }

  it('lets only one of two instances on the same server write to it', async () => {
    const manga = fakeDispatchManga(11);
    const fake = await start(manga);
    configure(
      dispatchInstanceFor(fake.server, 1),
      dispatchInstanceFor(fake.server, 2)
    );
    await seedDispatchBinding(manga, { instanceId: 1 });
    await seedDispatchBinding(manga, { instanceId: 2, anilistId: 9002 });
    const { request: first } = await seedDispatchRequest({ instanceId: 1 });
    const { request: second } = await seedDispatchRequest({
      instanceId: 2,
      anilistId: 9002,
    });
    const client = dispatchClientFor(fake.server);

    assert.deepStrictEqual(await run(first.id, fake, client), {
      delivered: true,
    });
    const writes = fake.writes().length;
    assert.deepStrictEqual(await run(second.id, fake, client), {
      delivered: true,
    });

    assert.strictEqual(
      (await manifestOf(second.id)).lastError,
      MangaDispatchError.INSTANCE_MISMATCH
    );
    assert.strictEqual(fake.writes().length, writes);
    assert.strictEqual(await ownMarker(2), undefined);
    assert.strictEqual(
      fake.state.globalMeta.get(INSTANCE_MARKER_KEY),
      await ownMarker(1)
    );
  });

  it('lets only one of two instances mark an unmarked server they share at once', async () => {
    const manga = fakeDispatchManga(11);
    const fake = await start(manga);
    configure(
      dispatchInstanceFor(fake.server, 1),
      dispatchInstanceFor(fake.server, 2)
    );
    await seedDispatchBinding(manga, { instanceId: 1 });
    await seedDispatchBinding(manga, { instanceId: 2, anilistId: 9002 });
    const { request: first } = await seedDispatchRequest({ instanceId: 1 });
    const { request: second } = await seedDispatchRequest({
      instanceId: 2,
      anilistId: 9002,
    });
    // The first marker read waits for the other instance's read, or long
    // enough for it to arrive if nothing held it back.
    let reads = 0;
    let bothRead!: () => void;
    const together = new Promise<void>((resolve) => {
      bothRead = resolve;
    });
    const clients = [first, second].map(() => {
      const client = dispatchClientFor(fake.server);
      const read = client.getInstanceMarker.bind(client);
      mock.method(
        client,
        'getInstanceMarker',
        async (options?: Parameters<typeof read>[0]) => {
          const marker = await read(options);
          reads += 1;
          if (reads === 2) {
            bothRead();
          }
          await Promise.race([together, sleep(300)]);
          return marker;
        }
      );
      return client;
    });

    assert.deepStrictEqual(
      await Promise.all([
        run(first.id, fake, clients[0]),
        run(second.id, fake, clients[1]),
      ]),
      [{ delivered: true }, { delivered: true }]
    );

    const manifests = await Promise.all([
      manifestOf(first.id),
      manifestOf(second.id),
    ]);
    const [winner, loser] =
      manifests[0].lastError === null ? manifests : manifests.reverse();
    assert.deepStrictEqual(
      [winner.checkpoint, winner.lastError, loser.checkpoint, loser.lastError],
      [CHAPTERS_ENQUEUED, null, null, MangaDispatchError.INSTANCE_MISMATCH]
    );
    assert.strictEqual(fake.server.operations('SetInstanceMarker').length, 1);
    assert.deepStrictEqual(
      (await getRepository(MangaInstanceMarker).find()).map((row) => [
        row.instanceId,
        row.marker,
      ]),
      [[winner.instanceId, fake.state.globalMeta.get(INSTANCE_MARKER_KEY)]]
    );
    assert.strictEqual(fake.indexEntry(loser.requestId), undefined);
    assert.deepStrictEqual(fake.stamp(11), {
      ...stampOf([winner.requestId]),
      anilistId: winner.anilistId,
    });
  });

  it('takes over the marker of an instance that is no longer configured', async () => {
    const { fake, requestId } = await setup();
    const { marker } = await saveMarker(7);
    fake.state.globalMeta.set(INSTANCE_MARKER_KEY, marker);

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.deepStrictEqual(
      (await getRepository(MangaInstanceMarker).find()).map((row) => [
        row.instanceId,
        row.marker,
      ]),
      [[1, marker]]
    );
    assert.strictEqual(fake.server.operations('SetInstanceMarker').length, 0);
    assert.deepStrictEqual(
      logged('Suwayomi instance took over a removed instance marker'),
      [
        [
          'info',
          { label: 'Manga Dispatch', instanceId: 1, previousInstanceId: 7 },
        ],
      ]
    );
    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
  });
});

describe('manga dispatch: library ownership', () => {
  it('never claims a library entry the user added, even after they remove it', async () => {
    const { fake, requestId } = await setup([
      fakeDispatchManga(11, { inLibrary: true }),
    ]);

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.strictEqual(fake.server.operations('SetInLibrary').length, 0);
    assert.deepStrictEqual(await libraryOwnership(), [
      [1, FAKE_SOURCE_ID, fakeMangaUrl(11), false],
    ]);
    assert.deepStrictEqual(fake.stamp(11), stampOf([requestId], false));

    fake.manga(11).inLibrary = false;
    await setManifest(requestId, { checkpoint: null });

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.strictEqual(fake.manga(11).inLibrary, true);
    assert.deepStrictEqual(await libraryOwnership(), [
      [1, FAKE_SOURCE_ID, fakeMangaUrl(11), false],
    ]);
    assert.deepStrictEqual(fake.stamp(11), stampOf([requestId], false));
  });
});

describe('manga dispatch: chapter fetch', () => {
  for (const fault of ['partial', 'error'] as const) {
    it(`counts a fetch answered with ${fault === 'partial' ? 'partial data' : 'an error'} as failed`, async () => {
      const { fake, requestId } = await setup();
      fake.fault('FetchMangaAndChapters', fault);

      assert.deepStrictEqual(await run(requestId, fake), { delivered: false });

      const manifest = await manifestOf(requestId);
      assert.deepStrictEqual(
        [
          manifest.checkpoint,
          manifest.frozenAt,
          manifest.lastError,
          manifest.attempts,
          manifest.retryNotBefore,
        ],
        [CATEGORY_READY, null, MangaDispatchError.SOURCE_FETCH_FAILED, 1, null]
      );
      assert.deepStrictEqual(await frozenChapterUrls(requestId), []);
      assert.deepStrictEqual(await run(requestId, fake), { delivered: true });
      assert.strictEqual(
        (await manifestOf(requestId)).checkpoint,
        CHAPTERS_ENQUEUED
      );
    });
  }

  it(`moves to the slow schedule after ${MANGA_SOURCE_FETCH_ATTEMPTS} failed fetches in a row`, async () => {
    const { fake, requestId } = await setup();
    fake.fault(
      'FetchMangaAndChapters',
      ...Array.from(
        { length: MANGA_SOURCE_FETCH_ATTEMPTS },
        () => 'error' as const
      )
    );
    for (let attempt = 1; attempt < MANGA_SOURCE_FETCH_ATTEMPTS; attempt += 1) {
      assert.deepStrictEqual(await run(requestId, fake), { delivered: false });
      const manifest = await manifestOf(requestId);
      assert.deepStrictEqual(
        [manifest.lastError, manifest.attempts, manifest.retryNotBefore],
        [MangaDispatchError.SOURCE_FETCH_FAILED, attempt, null]
      );
    }
    const startedAt = Date.now();

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [manifest.checkpoint, manifest.lastError, manifest.attempts],
      [
        CATEGORY_READY,
        MangaDispatchError.SOURCE_UNAVAILABLE,
        MANGA_SOURCE_FETCH_ATTEMPTS,
      ]
    );
    assertWaits(manifest, MANGA_DISPATCH_WAIT_MS.attention, startedAt);
  });

  it('counts a Suwayomi failure during the fetch as Suwayomi being unavailable', async () => {
    const { fake, requestId } = await setup();
    fake.fault('FetchMangaAndChapters', 'applied-error');

    assert.deepStrictEqual(await run(requestId, fake), { delivered: false });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [manifest.checkpoint, manifest.lastError, manifest.attempts],
      [CATEGORY_READY, MangaDispatchError.SUWAYOMI_UNAVAILABLE, 1]
    );
  });

  it('waits a day when no chapter matches, then fetches again', async () => {
    const { fake, requestId } = await setup([
      fakeDispatchManga(11, { chapters: [] }),
    ]);
    const startedAt = Date.now();

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    const waiting = await manifestOf(requestId);
    assert.deepStrictEqual(
      [
        waiting.checkpoint,
        waiting.frozenAt,
        waiting.lastError,
        waiting.attempts,
      ],
      [CHAPTERS_FETCHED, null, MangaDispatchError.NO_MATCHING_CHAPTERS, 0]
    );
    assertWaits(waiting, MANGA_DISPATCH_WAIT_MS.noMatchingChapters, startedAt);
    assert.deepStrictEqual(logged('Manga request dispatch is waiting'), [
      [
        'info',
        {
          label: 'Manga Dispatch',
          requestId,
          code: MangaDispatchError.NO_MATCHING_CHAPTERS,
        },
      ],
    ]);

    fake.manga(11).chapters = fakeDispatchChapters(11, [1, 2]);

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.strictEqual(
      fake.server.operations('FetchMangaAndChapters').length,
      2
    );
    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [manifest.checkpoint, manifest.lastError, manifest.retryNotBefore],
      [CHAPTERS_ENQUEUED, null, null]
    );
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2));
  });

  it('freezes only the chapters the request asks for', async () => {
    const { fake, requestId } = await setup(
      [
        fakeDispatchManga(11, {
          chapters: fakeDispatchChapters(11, range(1, 5)),
        }),
      ],
      {
        request: {
          manifest: { scope: MangaRequestScope.LATEST_N, latestCount: 2 },
        },
      }
    );

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.deepStrictEqual(
      await frozenChapterUrls(requestId),
      chapterUrls(11, 4, 5)
    );
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 4, 5));
  });
});

describe('manga dispatch: enqueue', () => {
  it('skips downloaded and queued chapters and owns only what it queued', async () => {
    const { fake, requestId } = await setup([
      fakeDispatchManga(11, {
        chapters: fakeDispatchChapters(11, [1, 2, 3, 4], [2]),
      }),
    ]);
    fake.state.queue.push(1103);

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.deepStrictEqual(
      await frozenChapterUrls(requestId),
      chapterUrls(11, 1, 2, 3, 4)
    );
    assert.deepStrictEqual(fake.enqueuedIds(), chapterIds(11, 1, 4));
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 3, 1, 4));
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 1, 4));
  });

  it('confirms a queue write whose answer never came', async () => {
    const { fake, requestId } = await setup();
    fake.fault('EnqueueChapters', 'applied-hang');

    assert.deepStrictEqual(
      await run(
        requestId,
        fake,
        dispatchClientFor(fake.server, { queue: 300 })
      ),
      { delivered: true }
    );

    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
    assert.ok(fake.server.operations('ChapterStates').length > 0);
  });

  it('queues fifty chapters per call', async () => {
    const { fake, requestId } = await setup([
      fakeDispatchManga(11, {
        chapters: fakeDispatchChapters(11, range(1, 120)),
      }),
    ]);

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.deepStrictEqual(
      fake.server
        .operations('EnqueueChapters')
        .map(({ variables }) => (variables.ids as unknown[]).length),
      [50, 50, 20]
    );
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, ...range(1, 120)));
    assert.strictEqual(await getRepository(MangaChapterOwnership).count(), 120);
  });

  it('skips frozen chapters Suwayomi no longer lists, with a count', async () => {
    const { fake, requestId } = await setup();
    fake.observe((request) => {
      if (request.operationName === 'ChaptersToDownload') {
        fake.manga(11).chapters = fakeDispatchChapters(11, [1, 2]);
      }
    });

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.deepStrictEqual(
      await frozenChapterUrls(requestId),
      chapterUrls(11, 1, 2, 3)
    );
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2));
    assert.deepStrictEqual(
      logged('Manga chapters Suwayomi no longer lists were skipped'),
      [
        [
          'warn',
          {
            label: 'Manga Dispatch',
            requestId,
            code: 'MANGA_CHAPTERS_UNMAPPED',
            count: 1,
          },
        ],
      ]
    );
    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
  });
});

describe('manga dispatch: guards', () => {
  it('returns at once when the request needs no dispatch', async () => {
    const fake = await start(fakeDispatchManga(11));
    configure(dispatchInstanceFor(fake.server));
    await seedDispatchBinding(fake.manga(11));
    const { request: pending } = await seedDispatchRequest({
      anilistId: 9001,
      status: MediaRequestStatus.PENDING,
    });
    const { request: parked } = await seedDispatchRequest({
      anilistId: 9002,
      manifest: { bindingState: AWAITING_BINDING, boundAt: null },
    });
    const { request: unmanifested } = await seedDispatchRequest({
      anilistId: 9003,
    });
    await getRepository(MangaRequestManifest).delete({
      requestId: unmanifested.id,
    });
    const { request: disabled } = await seedDispatchRequest({
      anilistId: 9004,
    });

    for (const request of [pending, parked, unmanifested]) {
      assert.deepStrictEqual(await run(request.id, fake), { delivered: true });
    }
    settings.main.enabledMediaCategories = { ...categories, manga: false };
    assert.deepStrictEqual(await run(disabled.id, fake), { delivered: true });

    assert.deepStrictEqual(fake.server.requests, []);
    for (const request of [pending, parked, disabled]) {
      const manifest = await manifestOf(request.id);
      assert.deepStrictEqual(
        [manifest.checkpoint, manifest.lastError, manifest.attempts],
        [null, null, 0]
      );
    }
  });

  it('waits when its instance is gone or has no client', async () => {
    const fake = await start(fakeDispatchManga(11));
    const { request } = await seedDispatchRequest();
    const clients: (() => Client | undefined)[] = [
      () => dispatchClientFor(fake.server),
      () => undefined,
      () => {
        throw new SuwayomiError('INVALID_ARGUMENT', 'Client');
      },
    ];

    for (const [index, clientFor] of clients.entries()) {
      configure(...(index === 0 ? [] : [dispatchInstanceFor(fake.server)]));
      const startedAt = Date.now();

      assert.deepStrictEqual(
        await dispatchMangaRequest(await loadDispatchRequest(request.id), {
          clientFor,
        }),
        { delivered: true }
      );

      const manifest = await manifestOf(request.id);
      assert.deepStrictEqual(
        [manifest.checkpoint, manifest.lastError, manifest.attempts],
        [null, MangaDispatchError.INSTANCE_MISSING, 0]
      );
      assertWaits(manifest, MANGA_DISPATCH_WAIT_MS.attention, startedAt);
    }
    assert.deepStrictEqual(fake.server.requests, []);
  });

  it('stops when the instance changes while it runs', async () => {
    const { fake, requestId } = await setup();
    fake.observe((request) => {
      if (request.operationName === 'SetInLibrary') {
        settings.suwayomi = [dispatchInstanceFor(fake.server, 1, { port: 1 })];
      }
    });

    assert.deepStrictEqual(await run(requestId, fake), { delivered: false });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [manifest.checkpoint, manifest.lastError, manifest.attempts],
      [INSTANCE_MARKED, MangaDispatchError.INSTANCE_CHANGED, 1]
    );
    assert.strictEqual(fake.server.operations('CreateCategory').length, 0);
  });

  it('stops when the instance changes before it starts a request over', async () => {
    const fake = await start();
    configure(dispatchInstanceFor(fake.server));
    await seedDispatchBinding(fakeDispatchManga(11));
    const { marker } = await saveMarker(1);
    fake.state.globalMeta.set(INSTANCE_MARKER_KEY, marker);
    const { request } = await seedDispatchRequest({
      manifest: { checkpoint: CATEGORY_READY },
    });
    fake.observe((call) => {
      if (call.operationName === 'InstanceMarker') {
        settings.suwayomi = [dispatchInstanceFor(fake.server, 1, { port: 1 })];
      }
    });

    assert.deepStrictEqual(await run(request.id, fake), { delivered: false });

    const manifest = await manifestOf(request.id);
    assert.deepStrictEqual(
      [
        manifest.bindingState,
        manifest.checkpoint,
        manifest.lastError,
        manifest.attempts,
      ],
      [BOUND, CATEGORY_READY, MangaDispatchError.INSTANCE_CHANGED, 1]
    );
  });

  it('stops when the bound manga changed under it', async () => {
    const { fake, requestId } = await setup();
    fake.observe((request) => {
      if (request.operationName === 'MangaDetails') {
        fake.manga(11).url = fakeMangaUrl('moved');
      }
    });

    assert.deepStrictEqual(await run(requestId, fake), { delivered: false });

    const manifest = await manifestOf(requestId);
    assert.deepStrictEqual(
      [manifest.checkpoint, manifest.lastError, manifest.attempts],
      [INSTANCE_MARKED, MangaDispatchError.BINDING_MISSING, 1]
    );
    assert.strictEqual(fake.server.operations('SetInLibrary').length, 0);
    assert.deepStrictEqual(await libraryOwnership(), []);
  });

  it('overwrites a malformed stamp and index entry without logging them', async () => {
    const { fake, requestId } = await setup([
      fakeDispatchManga(11, {
        meta: { [REQUEST_STAMP_KEY]: `{"v":1,"requestIds":"${MALFORMED}` },
      }),
    ]);
    fake.state.globalMeta.set(
      `${REQUEST_INDEX_PREFIX}${requestId}`,
      `${MALFORMED}{`
    );

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.deepStrictEqual(fake.stamp(11), stampOf([requestId]));
    assert.deepStrictEqual(fake.indexEntry(requestId), {
      sourceId: FAKE_SOURCE_ID,
      url: fakeMangaUrl(11),
      mangaId: 11,
    });
  });

  it('calls Suwayomi outside every transaction and enters no admission', async () => {
    const { fake, requestId } = await setup();
    const transaction = dataSource.transaction.bind(dataSource) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let depth = 0;
    let transactions = 0;
    mock.method(dataSource, 'transaction', async (...args: unknown[]) => {
      depth += 1;
      transactions += 1;
      try {
        return await transaction(...args);
      } finally {
        depth -= 1;
      }
    });
    const inside: string[] = [];
    fake.observe((request) => {
      if (depth > 0) {
        inside.push(request.operationName ?? 'unnamed');
      }
    });
    const admissions = [
      mock.method(mediaRequestModule, 'runWithRequestAdmission'),
      mock.method(mediaMutation, 'runMediaEntityMutation'),
      mock.method(serviceAdmission, 'runWithServarrServiceAdmission'),
      mock.method(serviceAdmission, 'runWithServarrServiceCollectionAdmission'),
      mock.method(instanceAdmission, 'runWithSuwayomiInstanceAdmission'),
      mock.method(userSecurityMutation, 'runUserSecurityMutation'),
    ];

    assert.deepStrictEqual(await run(requestId, fake), { delivered: true });

    assert.strictEqual(
      (await manifestOf(requestId)).checkpoint,
      CHAPTERS_ENQUEUED
    );
    assert.ok(transactions >= 7, `only ${transactions} transactions`);
    assert.deepStrictEqual(inside, []);
    assert.deepStrictEqual(
      admissions.map((admission) => admission.mock.callCount()),
      admissions.map(() => 0)
    );
  });
});

describe('findDueMangaRequestIds', () => {
  const setUpdatedAt = (id: number, iso: string) =>
    dataSource
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ updatedAt: new Date(iso) })
      .where({ id })
      .callListeners(false)
      .execute();

  it('finds approved, bound, unfinished requests past their wait and outside the outbox, oldest first', async () => {
    const seed = async (
      anilistId: number,
      manifest: ManifestValues = {},
      status = MediaRequestStatus.APPROVED
    ) =>
      (await seedDispatchRequest({ anilistId, status, manifest })).request.id;
    const fresh = await seed(9101);
    const frozen = await seed(9102, {
      checkpoint: MANIFEST_FROZEN,
      frozenAt: new Date(),
    });
    const waited = await seed(9103, {
      lastError: MangaDispatchError.SOURCE_UNAVAILABLE,
      retryNotBefore: new Date(Date.now() - 60_000),
    });
    await seed(9104, { checkpoint: CHAPTERS_ENQUEUED });
    await seed(9105, { bindingState: AWAITING_BINDING, boundAt: null });
    await seed(9106, { retryNotBefore: new Date(Date.now() + 3_600_000) });
    await seed(9107, {}, MediaRequestStatus.PENDING);
    await seed(9108, {}, MediaRequestStatus.DECLINED);
    const queued = await seed(9109);
    await getRepository(RequestDispatchOutbox)
      .createQueryBuilder()
      .insert()
      .into(RequestDispatchOutbox)
      .values({ requestId: queued })
      .execute();
    await setUpdatedAt(fresh, '2020-01-02T00:00:00.000Z');
    await setUpdatedAt(frozen, '2020-01-02T00:00:00.000Z');
    await setUpdatedAt(waited, '2020-01-01T00:00:00.000Z');

    assert.deepStrictEqual(await findDueMangaRequestIds(50), [
      waited,
      fresh,
      frozen,
    ]);
    assert.deepStrictEqual(await findDueMangaRequestIds(2), [waited, fresh]);
  });
});

describe('retryApprovedMangaRequests', () => {
  const sweep = (limit?: number) =>
    new MediaRequestSubscriber().retryApprovedMangaRequests(limit);

  const recordEnqueues = () => {
    const enqueued: number[] = [];
    mock.method(
      requestDispatchManager,
      'enqueue',
      async (requestId: number) => {
        enqueued.push(requestId);
      }
    );
    return enqueued;
  };

  it('queues every due request', async () => {
    const enqueued = recordEnqueues();
    const first = (await seedDispatchRequest({ anilistId: 9101 })).request.id;
    const second = (await seedDispatchRequest({ anilistId: 9102 })).request.id;
    await seedDispatchRequest({
      anilistId: 9103,
      manifest: { checkpoint: CHAPTERS_ENQUEUED },
    });

    await sweep();

    assert.deepStrictEqual(enqueued, [first, second]);
  });

  it('does nothing while manga is disabled', async () => {
    const enqueued = recordEnqueues();
    const found = mock.method(mangaDispatch, 'findDueMangaRequestIds');
    await seedDispatchRequest();
    settings.main.enabledMediaCategories = { ...categories, manga: false };

    await sweep();

    assert.strictEqual(found.mock.callCount(), 0);
    assert.deepStrictEqual(enqueued, []);
  });

  it('bounds how many requests one sweep queues', async () => {
    recordEnqueues();
    const limits: number[] = [];
    mock.method(
      mangaDispatch,
      'findDueMangaRequestIds',
      async (limit: number) => {
        limits.push(limit);
        return [];
      }
    );

    for (const limit of [undefined, 0, -1, 1.5, Number.NaN, 7, 500, 501]) {
      await sweep(limit);
    }

    assert.deepStrictEqual(limits, [
      MANGA_DISPATCH_SWEEP_LIMIT,
      MANGA_DISPATCH_SWEEP_LIMIT,
      MANGA_DISPATCH_SWEEP_LIMIT,
      MANGA_DISPATCH_SWEEP_LIMIT,
      MANGA_DISPATCH_SWEEP_LIMIT,
      7,
      MAX_MANGA_DISPATCH_SWEEP_LIMIT,
      MAX_MANGA_DISPATCH_SWEEP_LIMIT,
    ]);
  });
});

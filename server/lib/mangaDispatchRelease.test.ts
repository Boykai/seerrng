import {
  INSTANCE_MARKER_KEY,
  REQUEST_INDEX_PREFIX,
  REQUEST_STAMP_KEY,
} from '@server/api/suwayomi/operations';
import {
  MangaRequestCheckpoint,
  MangaRequestScope,
} from '@server/constants/mangaRequest';
import { MediaRequestStatus } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaInstanceMarker from '@server/entity/MangaInstanceMarker';
import MangaLibraryOwnership from '@server/entity/MangaLibraryOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import { hashMangaSourceUrl } from '@server/entity/MangaSourceBinding';
import * as mediaRequestModule from '@server/entity/MediaRequest';
import { MediaRequest } from '@server/entity/MediaRequest';
import * as mangaDispatch from '@server/lib/mangaDispatch';
import {
  dispatchMangaRequest,
  releaseMangaDispatch,
  runWithMangaDispatchLock,
} from '@server/lib/mangaDispatch';
import * as mediaMutation from '@server/lib/mediaMutation';
import * as serviceAdmission from '@server/lib/serviceAdmission';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import * as instanceAdmission from '@server/lib/suwayomi/instanceAdmission';
import * as userSecurityMutation from '@server/lib/userSecurityMutation';
import logger from '@server/logger';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  DISPATCH_WRITE_OPERATIONS,
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
import { inspect } from 'node:util';

setupTestDb();

const { CHAPTERS_ENQUEUED } = MangaRequestCheckpoint;
const { APPROVED, COMPLETED, DECLINED, FAILED } = MediaRequestStatus;
/** A value no log line may ever carry. */
const MALFORMED = 'MALFORMED-SENTINEL';
const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const fakes: FakeDispatchSuwayomi[] = [];

type Level = 'error' | 'warn' | 'info' | 'debug';
type LogEntry = [Level, string, Record<string, unknown>];
let logs: LogEntry[] = [];

type Client = ReturnType<typeof dispatchClientFor>;

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

const saveMarker = (instanceId: number, marker: string = randomUUID()) =>
  getRepository(MangaInstanceMarker).save(
    new MangaInstanceMarker({ instanceId, marker })
  );

/** Gives instance 1 a marker and puts the same marker on the server. */
const markServer = async (fake: FakeDispatchSuwayomi) => {
  const { marker } = await saveMarker(1);
  fake.state.globalMeta.set(INSTANCE_MARKER_KEY, marker);
};

const run = async (requestId: number, client: Client) =>
  dispatchMangaRequest(await loadDispatchRequest(requestId), {
    clientFor: () => client,
  });

/**
 * A fake serving `mangas` with `queued` already in its queue, instance 1
 * pointing at it, a binding of AniList 9001 to the first manga, and an
 * approved request for that title whose chapters are queued.
 */
const dispatched = async (
  mangas: FakeDispatchManga[] = [fakeDispatchManga(11)],
  {
    request = {},
    queued = [],
  }: {
    request?: Parameters<typeof seedDispatchRequest>[0];
    queued?: number[];
  } = {}
) => {
  const fake = await start(...mangas);
  fake.state.queue.push(...queued);
  configure(dispatchInstanceFor(fake.server));
  await seedDispatchBinding(mangas[0]);
  const seeded = await seedDispatchRequest(request);
  const client = dispatchClientFor(fake.server);
  assert.deepStrictEqual(await run(seeded.request.id, client), {
    delivered: true,
  });
  assert.strictEqual(
    (await manifestOf(seeded.request.id)).checkpoint,
    CHAPTERS_ENQUEUED
  );
  return { fake, client, requestId: seeded.request.id, media: seeded.media };
};

const release = (
  client: Client | undefined,
  options: { signal?: AbortSignal } = {}
) => releaseMangaDispatch({ ...options, clientFor: () => client });

const setStatus = (id: number, status: MediaRequestStatus) =>
  dataSource
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status })
    .where({ id })
    .callListeners(false)
    .execute();

const deleteRequest = (id: number) =>
  dataSource
    .createQueryBuilder()
    .delete()
    .from(MediaRequest)
    .where({ id })
    .callListeners(false)
    .execute();

/** The chapter IDs of each DequeueChapters call. */
const dequeued = (fake: FakeDispatchSuwayomi) =>
  fake.server
    .operations('DequeueChapters')
    .map(({ variables }) => (variables.ids as unknown[]).map(Number));

/** Operation names after the first `sent` requests. */
const operationsSince = (fake: FakeDispatchSuwayomi, sent: number) =>
  fake.server.requests.slice(sent).map(({ operationName }) => operationName);

/** Write operation names after the first `sent` requests. */
const writesSince = (fake: FakeDispatchSuwayomi, sent: number) =>
  operationsSince(fake, sent).filter(
    (name) => name !== undefined && DISPATCH_WRITE_OPERATIONS.has(name)
  );

const indexKeys = (fake: FakeDispatchSuwayomi) =>
  [...fake.state.globalMeta.keys()]
    .filter((key) => key.startsWith(REQUEST_INDEX_PREFIX))
    .sort();

const setIndex = (
  fake: FakeDispatchSuwayomi,
  requestId: number,
  value: unknown
) =>
  fake.state.globalMeta.set(
    `${REQUEST_INDEX_PREFIX}${requestId}`,
    typeof value === 'string' ? value : JSON.stringify(value)
  );

const libraryOwnership = async () =>
  (
    await getRepository(MangaLibraryOwnership).find({ order: { id: 'ASC' } })
  ).map(({ instanceId, sourceId, url, addedBySeerrng }) => [
    instanceId,
    sourceId,
    url,
    addedBySeerrng,
  ]);

const ownedChapterUrls = async () =>
  (
    await getRepository(MangaChapterOwnership).find({ order: { id: 'ASC' } })
  ).map(({ chapterUrl }) => chapterUrl);

const chapterUrls = (mangaId: number, ...numbers: number[]) =>
  numbers.map((chapterNumber) => fakeChapterUrl(mangaId, chapterNumber));

const chapterIds = (mangaId: number, ...numbers: number[]) =>
  numbers.map((chapterNumber) => mangaId * 100 + chapterNumber);

const range = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index);

/** Ownership rows for chapters 1 to `count`, spread over `mangaIds`. */
const insertOwnedChapters = async (
  instanceId: number,
  count: number,
  mangaIds = [11]
) => {
  const rows = range(1, count).map((chapterNumber) => {
    const mangaId = mangaIds[chapterNumber % mangaIds.length];
    const chapterUrl = fakeChapterUrl(mangaId, chapterNumber);
    return {
      instanceId,
      sourceId: FAKE_SOURCE_ID,
      mangaUrlHash: hashMangaSourceUrl(fakeMangaUrl(mangaId)),
      chapterUrl,
      chapterUrlHash: hashMangaSourceUrl(chapterUrl),
    };
  });
  for (let index = 0; index < rows.length; index += 100) {
    await getRepository(MangaChapterOwnership).insert(
      rows.slice(index, index + 100)
    );
  }
};

const markerReads = (fake: FakeDispatchSuwayomi) =>
  fake.operationNames().filter((name) => name === 'InstanceMarker').length;

const stampOf = (requestIds: number[], addedBySeerrng = true) => ({
  v: 1,
  requestIds: [...requestIds].sort((a, b) => a - b),
  addedBySeerrng,
  anilistId: 9001,
});

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

describe('manga dispatch release: chapters', () => {
  it('dequeues only the still-queued chapters SeerrNG queued for a declined request', async () => {
    const { fake, client, requestId } = await dispatched(
      [
        fakeDispatchManga(11, {
          chapters: fakeDispatchChapters(11, range(1, 5), [5]),
        }),
        fakeDispatchManga(12, { chapters: fakeDispatchChapters(12, [5]) }),
      ],
      { queued: [1103, 1205] }
    );
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 1, 2, 4));
    // Suwayomi downloads chapter 1; the user takes chapter 4 off the queue.
    fake.manga(11).chapters[0].isDownloaded = true;
    fake.state.queue = fake.state.queue.filter(
      (id) => id !== 1101 && id !== 1104
    );
    await setStatus(requestId, DECLINED);
    const sent = fake.server.requests.length;

    await release(client);

    assert.deepStrictEqual(dequeued(fake), [chapterIds(11, 2)]);
    assert.deepStrictEqual(fake.state.queue, [1103, 1205]);
    assert.deepStrictEqual(await ownedChapterUrls(), []);
    assert.deepStrictEqual(writesSince(fake, sent), [
      'DequeueChapters',
      'SetRequestStamp',
      'DeleteRequestIndex',
    ]);
    assert.strictEqual(fake.indexEntry(requestId), undefined);
    assert.deepStrictEqual(fake.stamp(11), stampOf([]));
    assert.strictEqual(fake.manga(11).inLibrary, true);
    assert.deepStrictEqual(fake.manga(11).categoryIds, [1]);
    assert.deepStrictEqual(fake.state.categories, [{ id: 1, name: 'SeerrNG' }]);
    assert.deepStrictEqual(
      fake
        .manga(11)
        .chapters.filter(({ isDownloaded }) => isDownloaded)
        .map(({ chapterNumber }) => chapterNumber),
      [1, 5]
    );
    assert.deepStrictEqual(await libraryOwnership(), [
      [1, FAKE_SOURCE_ID, fakeMangaUrl(11), true],
    ]);

    const again = fake.server.requests.length;
    await release(client);

    assert.deepStrictEqual(writesSince(fake, again), []);
  });

  for (const [name, status] of [
    ['failed', FAILED],
    ['completed', COMPLETED],
  ] as const) {
    it(`dequeues the chapters of a ${name} request`, async () => {
      const { fake, client, requestId } = await dispatched();
      await setStatus(requestId, status);

      await release(client);

      assert.deepStrictEqual(dequeued(fake), [chapterIds(11, 1, 2, 3)]);
      assert.deepStrictEqual(fake.state.queue, []);
      assert.deepStrictEqual(await ownedChapterUrls(), []);
    });
  }

  it('keeps the chapters another approved request needs, and releases them once it is deleted', async () => {
    const { fake, client, requestId: first, media } = await dispatched();
    const { request } = await seedDispatchRequest({
      media,
      manifest: { scope: MangaRequestScope.LATEST_N, latestCount: 1 },
    });
    const second = request.id;
    assert.deepStrictEqual(await run(second, client), { delivered: true });
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
    await setStatus(first, DECLINED);

    await release(client);

    assert.deepStrictEqual(dequeued(fake), [chapterIds(11, 1, 2)]);
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 3));
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 3));
    assert.deepStrictEqual(fake.stamp(11), stampOf([second]));
    assert.deepStrictEqual(indexKeys(fake), [
      `${REQUEST_INDEX_PREFIX}${second}`,
    ]);

    const { id: manifestId } = await manifestOf(second);
    await deleteRequest(second);
    assert.strictEqual(
      await getRepository(MangaRequestManifest).countBy({
        requestId: second,
      }),
      0
    );
    assert.strictEqual(
      await getRepository(MangaRequestChapter).countBy({ manifestId }),
      0
    );

    await release(client);

    assert.deepStrictEqual(dequeued(fake), [
      chapterIds(11, 1, 2),
      chapterIds(11, 3),
    ]);
    assert.deepStrictEqual(fake.state.queue, []);
    assert.deepStrictEqual(await ownedChapterUrls(), []);
    assert.deepStrictEqual(fake.stamp(11), stampOf([]));
    assert.deepStrictEqual(indexKeys(fake), []);
  });

  it('dequeues fifty chapters per call', async () => {
    const { fake, client, requestId } = await dispatched([
      fakeDispatchManga(11, {
        chapters: fakeDispatchChapters(11, range(1, 120)),
      }),
    ]);
    await setStatus(requestId, DECLINED);

    await release(client);

    assert.deepStrictEqual(
      dequeued(fake).map((ids) => ids.length),
      [50, 50, 20]
    );
    assert.deepStrictEqual(
      dequeued(fake).flat(),
      chapterIds(11, ...range(1, 120))
    );
    assert.deepStrictEqual(fake.state.queue, []);
    assert.strictEqual(await getRepository(MangaChapterOwnership).count(), 0);
  });

  it('holds the manga lock until the released rows are gone', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
    let waiting: Promise<number> | undefined;
    fake.observe((request) => {
      if (request.operationName === 'DequeueChapters' && !waiting) {
        waiting = runWithMangaDispatchLock(
          1,
          FAKE_SOURCE_ID,
          hashMangaSourceUrl(fakeMangaUrl(11)),
          () => getRepository(MangaChapterOwnership).count()
        );
      }
    });

    await release(client);

    assert.ok(waiting);
    assert.strictEqual(await waiting, 0);
  });

  it('leaves everything in place until the server carries its own marker', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
    const marker = await getRepository(MangaInstanceMarker).findOneByOrFail({
      instanceId: 1,
    });
    const variants: [string, () => Promise<unknown>, number][] = [
      [
        'another marker',
        async () =>
          fake.state.globalMeta.set(INSTANCE_MARKER_KEY, randomUUID()),
        2,
      ],
      [
        'no marker on the server',
        async () => fake.state.globalMeta.delete(INSTANCE_MARKER_KEY),
        2,
      ],
      [
        'no marker of its own',
        async () => {
          fake.state.globalMeta.set(INSTANCE_MARKER_KEY, marker.marker);
          await getRepository(MangaInstanceMarker).delete(marker.id);
        },
        0,
      ],
    ];

    for (const [variant, prepare, reads] of variants) {
      await prepare();
      const sent = fake.server.requests.length;

      await release(client);

      assert.deepStrictEqual(
        operationsSince(fake, sent),
        Array.from({ length: reads }, () => 'InstanceMarker'),
        variant
      );
      assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
      assert.deepStrictEqual(
        await ownedChapterUrls(),
        chapterUrls(11, 1, 2, 3)
      );
      assert.notStrictEqual(fake.indexEntry(requestId), undefined);
    }

    await saveMarker(1, marker.marker);
    await release(client);

    assert.deepStrictEqual(fake.state.queue, []);
    assert.deepStrictEqual(await ownedChapterUrls(), []);
    assert.strictEqual(fake.indexEntry(requestId), undefined);
  });

  it('keeps the chapters when Suwayomi fails and releases them on the next run', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
    fake.fault('Queue', 'error');

    await release(client);

    assert.deepStrictEqual(logged('Manga dispatch release will retry'), [
      [
        'warn',
        {
          label: 'Manga Dispatch',
          instanceId: 1,
          suwayomiCode: 'UPSTREAM_ERROR',
          operation: 'Queue',
        },
      ],
    ]);
    assert.deepStrictEqual(dequeued(fake), []);
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 1, 2, 3));
    // The request notes are released independently.
    assert.strictEqual(fake.indexEntry(requestId), undefined);
    assert.deepStrictEqual(fake.stamp(11), stampOf([]));

    await release(client);

    assert.deepStrictEqual(dequeued(fake), [chapterIds(11, 1, 2, 3)]);
    assert.deepStrictEqual(fake.state.queue, []);
    assert.deepStrictEqual(await ownedChapterUrls(), []);
  });

  it('forgets the chapters of a removed instance without calling it', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
    configure();
    const sent = fake.server.requests.length;

    await release(client);

    assert.strictEqual(fake.server.requests.length, sent);
    assert.deepStrictEqual(await ownedChapterUrls(), []);
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
  });

  it('forgets the chapters of a manga Suwayomi no longer has', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
    fake.state.mangas = [];
    const sent = fake.server.requests.length;

    await release(client);

    assert.deepStrictEqual(writesSince(fake, sent), ['DeleteRequestIndex']);
    assert.deepStrictEqual(await ownedChapterUrls(), []);
  });

  it('forgets chapters whose library entry it has no record of, with a count', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
    await getRepository(MangaLibraryOwnership).clear();

    await release(client);

    assert.deepStrictEqual(
      logged('Released manga chapters had no library record'),
      [
        [
          'warn',
          {
            label: 'Manga Dispatch',
            instanceId: 1,
            code: 'MANGA_RELEASE_UNRESOLVED',
            count: 3,
          },
        ],
      ]
    );
    assert.deepStrictEqual(dequeued(fake), []);
    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
    assert.deepStrictEqual(await ownedChapterUrls(), []);
    assert.deepStrictEqual(fake.stamp(11), stampOf([], false));
  });

  it('keeps the chapters when the instance changes during the release', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
    fake.observe((request) => {
      if (request.operationName === 'DequeueChapters') {
        settings.suwayomi = [dispatchInstanceFor(fake.server, 1, { port: 1 })];
      }
    });

    await releaseMangaDispatch({
      clientFor: () => (settings.suwayomi[0]?.port === 1 ? undefined : client),
    });

    assert.deepStrictEqual(dequeued(fake), [chapterIds(11, 1, 2, 3)]);
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 1, 2, 3));
    assert.deepStrictEqual(logged('Manga dispatch release will retry'), [
      ['warn', { label: 'Manga Dispatch', instanceId: 1, errorName: 'Error' }],
    ]);
    assert.notStrictEqual(fake.indexEntry(requestId), undefined);

    configure(dispatchInstanceFor(fake.server));
    await release(client);

    assert.strictEqual(dequeued(fake).length, 1);
    assert.deepStrictEqual(await ownedChapterUrls(), []);
    assert.strictEqual(fake.indexEntry(requestId), undefined);
  });

  it('releases at most 500 chapters per run', async () => {
    await insertOwnedChapters(2, 501);

    await release(undefined);

    assert.strictEqual(await getRepository(MangaChapterOwnership).count(), 1);

    await release(undefined);

    assert.strictEqual(await getRepository(MangaChapterOwnership).count(), 0);
  });

  it("keeps one server's waiting chapters from holding up another's", async () => {
    const fake = await start();
    configure(dispatchInstanceFor(fake.server));
    await saveMarker(1);
    fake.state.globalMeta.set(INSTANCE_MARKER_KEY, randomUUID());
    await insertOwnedChapters(1, 501, [11, 12, 13]);
    await insertOwnedChapters(2, 1);

    await release(dispatchClientFor(fake.server));

    assert.strictEqual(markerReads(fake), 2);
    assert.deepStrictEqual(fake.writes(), []);
    assert.strictEqual(
      await getRepository(MangaChapterOwnership).countBy({ instanceId: 1 }),
      501
    );
    assert.strictEqual(
      await getRepository(MangaChapterOwnership).countBy({ instanceId: 2 }),
      0
    );
  });

  it('logs a server it cannot reach once per pass, not once per manga', async () => {
    const fake = await start();
    configure(dispatchInstanceFor(fake.server));
    await markServer(fake);
    await insertOwnedChapters(1, 3, [11, 12, 13]);
    fake.fault('InstanceMarker', 'error', 'error', 'error', 'error');

    await release(dispatchClientFor(fake.server));

    const failure = {
      label: 'Manga Dispatch',
      instanceId: 1,
      suwayomiCode: 'UPSTREAM_ERROR',
      operation: 'InstanceMarker',
    };
    assert.deepStrictEqual(logged('Manga dispatch release will retry'), [
      ['warn', failure],
      ['warn', failure],
    ]);
    assert.strictEqual(markerReads(fake), 2);
    assert.strictEqual(await getRepository(MangaChapterOwnership).count(), 3);
  });
});

describe('manga dispatch release: request notes', () => {
  it('drops the index entries of requests no longer approved there and rewrites their stamps', async () => {
    const fake = await start(
      fakeDispatchManga(11, { inLibrary: true }),
      fakeDispatchManga(12, { inLibrary: true }),
      fakeDispatchManga(13, { inLibrary: true })
    );
    configure(dispatchInstanceFor(fake.server));
    await markServer(fake);
    await seedDispatchBinding(fake.manga(11));
    const boundTo = (mangaId: number) => ({
      bindingSourceId: FAKE_SOURCE_ID,
      bindingUrlHash: hashMangaSourceUrl(fakeMangaUrl(mangaId)),
      suwayomiMangaId: mangaId,
    });
    const seed = async (
      anilistId: number,
      status: MediaRequestStatus,
      manifest: Partial<MangaRequestManifest> = {},
      instanceId = 1
    ) =>
      (await seedDispatchRequest({ anilistId, status, instanceId, manifest }))
        .request.id;
    const approved = await seed(9001, APPROVED, boundTo(11));
    const declined = await seed(9002, DECLINED, boundTo(12));
    const completed = await seed(9003, COMPLETED, boundTo(11));
    const elsewhere = await seed(9004, APPROVED, {}, 2);
    const unstamped = await seed(9005, DECLINED, boundTo(13));
    const liveStamp = JSON.stringify({
      v: 1,
      requestIds: [approved],
      addedBySeerrng: false,
      anilistId: 9001,
    });
    fake.manga(11).meta[REQUEST_STAMP_KEY] = liveStamp;
    fake.manga(12).meta[REQUEST_STAMP_KEY] = JSON.stringify(
      stampOf([declined])
    );
    const entry = (mangaId: number) => ({
      sourceId: FAKE_SOURCE_ID,
      url: fakeMangaUrl(mangaId),
      mangaId,
    });
    setIndex(fake, approved, entry(11));
    setIndex(fake, declined, entry(12));
    setIndex(fake, completed, entry(11));
    setIndex(fake, elsewhere, { sourceId: FAKE_SOURCE_ID });
    setIndex(fake, unstamped, entry(13));
    // No such request, an unreadable value, a manga Suwayomi no longer has,
    // a manga ID out of range, and a key that names no request.
    setIndex(fake, 999_999, entry(11));
    setIndex(fake, 999_998, `${MALFORMED}{`);
    setIndex(fake, 999_997, entry(404));
    setIndex(fake, 999_996, { mangaId: 2_147_483_648 });
    setIndex(fake, 0, entry(11));
    const sent = fake.server.requests.length;

    await release(dispatchClientFor(fake.server));

    assert.deepStrictEqual(
      indexKeys(fake),
      [`${REQUEST_INDEX_PREFIX}${approved}`, `${REQUEST_INDEX_PREFIX}0`].sort()
    );
    assert.strictEqual(fake.server.operations('DeleteRequestIndex').length, 8);
    assert.deepStrictEqual(fake.stamp(12), {
      v: 1,
      requestIds: [],
      addedBySeerrng: false,
      anilistId: null,
    });
    assert.strictEqual(fake.manga(11).meta[REQUEST_STAMP_KEY], liveStamp);
    assert.strictEqual(fake.manga(13).meta[REQUEST_STAMP_KEY], undefined);
    assert.deepStrictEqual(
      fake.server
        .operations('MangaDetails')
        .map(({ variables }) => Number(variables.id))
        .sort((a, b) => a - b),
      [11, 11, 11, 11, 12, 12, 13, 13, 404]
    );
    const requests = fake.server.requests.slice(sent);
    const stampWrites = requests.flatMap((request, position) =>
      request.operationName === 'SetRequestStamp'
        ? [[position, Number(request.variables.mangaId)]]
        : []
    );
    assert.deepStrictEqual(
      stampWrites.map(([, mangaId]) => mangaId),
      [12]
    );
    const declinedDelete = requests.findIndex(
      ({ operationName, variables }) =>
        operationName === 'DeleteRequestIndex' &&
        variables.key === `${REQUEST_INDEX_PREFIX}${declined}`
    );
    assert.ok(stampWrites[0][0] < declinedDelete);
  });

  it('drops at most fifty index entries per run', async () => {
    const fake = await start();
    configure(dispatchInstanceFor(fake.server));
    await markServer(fake);
    for (const requestId of range(100_001, 100_051)) {
      setIndex(fake, requestId, {});
    }
    const client = dispatchClientFor(fake.server);

    await release(client);

    assert.strictEqual(fake.server.operations('DeleteRequestIndex').length, 50);
    assert.deepStrictEqual(indexKeys(fake), [`${REQUEST_INDEX_PREFIX}100051`]);

    await release(client);

    assert.deepStrictEqual(indexKeys(fake), []);
  });

  it('keeps the index entry of a request approved again while it is released', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, FAILED);
    let listed = false;
    let retried: Promise<unknown> | undefined;
    fake.observe((request) => {
      if (request.operationName === 'ReverseIndex') {
        listed = true;
      } else if (
        listed &&
        !retried &&
        request.operationName === 'MangaDetails'
      ) {
        // An administrator retries the request while the release reads its
        // manga, before the release takes the manga's lock.
        retried = runWithMangaDispatchLock(
          1,
          FAKE_SOURCE_ID,
          hashMangaSourceUrl(fakeMangaUrl(11)),
          () => setStatus(requestId, APPROVED)
        );
      }
    });

    await release(client);
    await retried;

    assert.ok(retried, 'the release read no manga');
    assert.strictEqual(fake.server.operations('DeleteRequestIndex').length, 0);
    assert.deepStrictEqual(fake.indexEntry(requestId), {
      sourceId: FAKE_SOURCE_ID,
      url: fakeMangaUrl(11),
      mangaId: 11,
    });
    assert.deepStrictEqual(fake.stamp(11), stampOf([requestId]));
  });
});

describe('manga dispatch release: discipline', () => {
  it('calls Suwayomi outside every transaction and enters no admission', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
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
    const sent = fake.server.requests.length;

    await release(client);

    assert.deepStrictEqual(writesSince(fake, sent), [
      'DequeueChapters',
      'SetRequestStamp',
      'DeleteRequestIndex',
    ]);
    assert.ok(transactions >= 1, 'no transaction');
    assert.deepStrictEqual(inside, []);
    assert.deepStrictEqual(
      admissions.map((admission) => admission.mock.callCount()),
      admissions.map(() => 0)
    );
  });

  it('stops at once when aborted', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
    const sent = fake.server.requests.length;
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(release(client, { signal: controller.signal }), {
      name: 'AbortError',
    });

    assert.strictEqual(fake.server.requests.length, sent);
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 1, 2, 3));
  });

  it('stops without a retry note when aborted during a call', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, DECLINED);
    const controller = new AbortController();
    fake.observe((request) => {
      if (request.operationName === 'DequeueChapters') {
        controller.abort();
      }
    });

    await assert.rejects(release(client, { signal: controller.signal }), {
      name: 'AbortError',
    });

    assert.deepStrictEqual(logged('Manga dispatch release will retry'), []);
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 1, 2, 3));
    assert.notStrictEqual(fake.indexEntry(requestId), undefined);
  });

  it('queues the released chapters again when a failed request is retried', async () => {
    const { fake, client, requestId } = await dispatched();
    await setStatus(requestId, FAILED);
    await release(client);
    assert.deepStrictEqual(fake.state.queue, []);
    // What the retry route does to a failed manga request.
    await setStatus(requestId, APPROVED);
    await getRepository(MangaRequestManifest).update(
      { requestId },
      {
        attempts: 0,
        retryNotBefore: null,
        lastError: null,
        checkpoint: null,
        checkpointAt: null,
      }
    );

    assert.deepStrictEqual(await run(requestId, client), { delivered: true });

    assert.deepStrictEqual(fake.state.queue, chapterIds(11, 1, 2, 3));
    assert.deepStrictEqual(await ownedChapterUrls(), chapterUrls(11, 1, 2, 3));
    assert.deepStrictEqual(fake.stamp(11), stampOf([requestId]));
    assert.deepStrictEqual(fake.indexEntry(requestId), {
      sourceId: FAKE_SOURCE_ID,
      url: fakeMangaUrl(11),
      mangaId: 11,
    });
  });
});

describe('retryApprovedMangaRequests: release', () => {
  const sweep = () => new MediaRequestSubscriber().retryApprovedMangaRequests();

  it('releases a request declined since the last sweep', async () => {
    const { fake, requestId } = await dispatched();
    const request = await loadDispatchRequest(requestId);
    request.status = DECLINED;
    await getRepository(MediaRequest).save(request);
    await waitForBackgroundTasks();

    await sweep();

    assert.deepStrictEqual(fake.state.queue, []);
    assert.deepStrictEqual(await ownedChapterUrls(), []);
    assert.strictEqual(fake.indexEntry(requestId), undefined);
    assert.deepStrictEqual(fake.stamp(11), stampOf([]));
  });

  it('releases even when finding due requests fails', async () => {
    mock.method(mangaDispatch, 'findDueMangaRequestIds', async () => {
      throw new Error('synthetic');
    });
    const released = mock.method(
      mangaDispatch,
      'releaseMangaDispatch',
      async () => undefined
    );

    await assert.rejects(sweep(), { message: 'synthetic' });

    assert.strictEqual(released.mock.callCount(), 1);
  });

  it('logs a failed release and finishes the sweep', async () => {
    const released = mock.method(
      mangaDispatch,
      'releaseMangaDispatch',
      async () => {
        throw new TypeError('synthetic');
      }
    );

    await sweep();

    assert.strictEqual(released.mock.callCount(), 1);
    assert.deepStrictEqual(logged('Manga dispatch release failed'), [
      ['warn', { label: 'Manga Dispatch', errorName: 'TypeError' }],
    ]);
  });

  it('releases nothing while manga is disabled', async () => {
    const released = mock.method(
      mangaDispatch,
      'releaseMangaDispatch',
      async () => undefined
    );
    settings.main.enabledMediaCategories = { ...categories, manga: false };

    await sweep();

    assert.strictEqual(released.mock.callCount(), 0);
  });
});

import AnilistAPI from '@server/api/anilist';
import type {
  AnilistMangaDetails,
  AnilistMangaStatus,
} from '@server/api/anilist/manga';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import { INSTANCE_MARKER_KEY } from '@server/api/suwayomi/operations';
import type { SuwayomiMangaStatus } from '@server/api/suwayomi/types';
import {
  MANGA_FOLLOW_WAIT_MS,
  MangaFollowStopReason,
} from '@server/constants/mangaFollow';
import {
  MangaAttentionCode,
  MangaChapterQueueState,
  MangaRequestBindingState,
  MangaRequestCheckpoint,
  MangaRequestScope,
} from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaInstanceMarker from '@server/entity/MangaInstanceMarker';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import * as mediaRequestModule from '@server/entity/MediaRequest';
import { MediaRequest } from '@server/entity/MediaRequest';
import MediaRequestStatusEvent from '@server/entity/MediaRequestStatusEvent';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { User } from '@server/entity/User';
import downloadTracker from '@server/lib/downloadtracker';
import {
  dispatchMangaRequest,
  findDueMangaRequestIds,
  releaseMangaDispatch,
} from '@server/lib/mangaDispatch';
import {
  isInsideMangaFollowLock,
  mangaFollowPoller,
  runMangaFollow,
  selectMangaFollowChapters,
  type MangaFollowClient,
  type MangaFollowCounts,
  type MangaFollowOptions,
} from '@server/lib/mangaFollow';
import { pollMangaProgress } from '@server/lib/mangaProgress';
import type {
  MangaChapterCandidate,
  MangaRequestScopeValue,
} from '@server/lib/mangaRequests';
import * as mediaMutation from '@server/lib/mediaMutation';
import notificationManager, { Notification } from '@server/lib/notifications';
import {
  RequestStatusStage,
  recordRequestStatus,
} from '@server/lib/requestStatus';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import * as instanceAdmission from '@server/lib/suwayomi/instanceAdmission';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import {
  DISPATCH_ALLOWED_OPERATIONS,
  FAKE_TITLE_PREFIX,
  FAKE_URL_PREFIX,
  dispatchClientFor,
  dispatchInstanceFor,
  fakeChapterUrl,
  fakeDispatchChapters,
  fakeDispatchManga,
  loadDispatchRequest,
  seedDispatchBinding,
  seedDispatchRequest,
  type FakeDispatchChapter,
  type FakeDispatchManga,
} from '@server/test/fakeSuwayomiDispatch';
import {
  assertProgressTraffic,
  seedProgressRequest,
  startFakeProgressSuwayomi,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

setupTestDb();

const { APPROVED, COMPLETED, DECLINED, FAILED, PENDING } = MediaRequestStatus;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const fakes: FakeProgressSuwayomi[] = [];
/** The run's client for each instance, by instance ID. */
const clients = new Map<number, MangaFollowClient>();

/** Every operation a follow check may send. */
const FOLLOW_OPERATIONS: ReadonlySet<string> = new Set([
  'ByNaturalKey',
  'ChapterStates',
  'ChaptersToDownload',
  'DownloadedChapters',
  'EnqueueChapters',
  'FetchMangaAndChapters',
  'InstanceMarker',
  'Queue',
]);

/** What a check that adds chapters and queues them sends. */
const CHECK_AND_QUEUE = [
  'InstanceMarker',
  'FetchMangaAndChapters',
  'ChaptersToDownload',
  'DownloadedChapters',
  'Queue',
  'EnqueueChapters',
];

type Level = 'error' | 'warn' | 'info' | 'debug';
type LogEntry = [Level, string, Record<string, unknown>];
type SeedOptions = Parameters<typeof seedProgressRequest>[1];

let logs: LogEntry[] = [];
let intents: { type: Notification; intent: unknown }[] = [];
/** Operations the fakes may receive in this test. */
let allowed: ReadonlySet<string> = FOLLOW_OPERATIONS;
/** Whether this test may ask for chapter archives. */
let heads = false;
/** Whether this test may queue notifications. */
let announcing = false;

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

/** `base`, with some of its calls replaced. */
const clientWith = (
  base: MangaFollowClient,
  overrides: Partial<MangaFollowClient> = {}
): MangaFollowClient => ({
  fetchMangaAndChapters: base.fetchMangaAndChapters.bind(base),
  findMangaByNaturalKey: base.findMangaByNaturalKey.bind(base),
  getInstanceMarker: base.getInstanceMarker.bind(base),
  getChaptersToDownload: base.getChaptersToDownload.bind(base),
  getDownloadedChapters: base.getDownloadedChapters.bind(base),
  getQueue: base.getQueue.bind(base),
  enqueueChapters: base.enqueueChapters.bind(base),
  ...overrides,
});

const saveMarker = (instanceId: number, marker: string = randomUUID()) =>
  getRepository(MangaInstanceMarker).save(
    new MangaInstanceMarker({ instanceId, marker })
  );

/** Gives `fake` the marker instance `instanceId` stores, as dispatch did. */
const markServer = async (fake: FakeProgressSuwayomi, instanceId: number) => {
  const { marker } = await saveMarker(instanceId);
  fake.state.globalMeta.set(INSTANCE_MARKER_KEY, marker);
};

/** A fake serving `mangas`, checked as instance `instanceId`. */
const start = async (mangas: FakeDispatchManga[], instanceId = 1) => {
  const fake = await startFakeProgressSuwayomi(mangas);
  fakes.push(fake);
  clients.set(instanceId, dispatchClientFor(fake.server));
  await markServer(fake, instanceId);
  return fake;
};

/** A run with fixed jitter and no AniList status unless `options` says. */
const follow = (options: MangaFollowOptions = {}) =>
  runMangaFollow({
    clientFor: (id) => clients.get(id),
    anilistStatus: async () => undefined,
    random: () => 0,
    ...options,
  });

const libraryManga = (id: number, overrides: Partial<FakeDispatchManga> = {}) =>
  fakeDispatchManga(id, { inLibrary: true, ...overrides });

/** A library manga with chapters `numbers`, `downloaded` of them on disk. */
const mangaWith = (
  id: number,
  numbers: readonly number[],
  downloaded: readonly number[] = []
) =>
  libraryManga(id, { chapters: fakeDispatchChapters(id, numbers, downloaded) });

const chapterOf = (
  overrides: Partial<FakeDispatchChapter> & {
    id: number;
    chapterNumber: number;
  }
): FakeDispatchChapter => ({
  url: fakeChapterUrl(Math.floor(overrides.id / 100), overrides.chapterNumber),
  isDownloaded: false,
  ...overrides,
});

/** Queues each frozen chapter not downloaded yet, as dispatch left it. */
const queueFrozen = (
  fake: FakeProgressSuwayomi,
  manga: FakeDispatchManga,
  rows: readonly MangaRequestChapter[]
) => {
  for (const row of rows) {
    const chapter = manga.chapters.find(({ url }) => url === row.url);
    if (
      chapter &&
      !chapter.isDownloaded &&
      !fake.state.queue.includes(chapter.id)
    ) {
      fake.state.queue.push(chapter.id);
    }
  }
};

/** Saving a request pending queued its own notification: not the run's. */
const forgetSeeding = async (requestId: number) => {
  await waitForBackgroundTasks();
  intents = intents.filter(
    ({ intent }) => (intent as { requestId?: unknown }).requestId !== requestId
  );
};

/**
 * A request dispatch enqueued on `manga`, owning its frozen chapters, whose
 * owner follows new chapters and is due a check.
 */
const seedFollowed = async (
  fake: FakeProgressSuwayomi,
  manga: FakeDispatchManga,
  options: SeedOptions = {}
) => {
  const seeded = await seedProgressRequest(manga, {
    owned: true,
    mediaStatus: MediaStatus.PROCESSING,
    ...options,
    manifest: { followEnabled: true, followNextAt: null, ...options.manifest },
  });
  queueFrozen(fake, manga, seeded.rows);
  await forgetSeeding(seeded.request.id);
  return { ...seeded, requestId: seeded.request.id };
};

/**
 * Manga `manga` (11, chapter 1 downloaded and 2 queued, by default) in
 * instance 1's library, AniList 9001 bound to it, and a followed request for
 * 9001 frozen to every chapter it lists.
 */
const setup = async (
  manga: FakeDispatchManga = mangaWith(11, [1, 2], [1]),
  {
    binding = {},
    ...options
  }: SeedOptions & {
    /** Null seeds no binding. */
    binding?: Partial<MangaSourceBinding> | null;
  } = {}
) => {
  const fake = await start([manga]);
  configure(dispatchInstanceFor(fake.server));
  const seededBinding =
    binding === null ? undefined : await seedDispatchBinding(manga, binding);
  return {
    fake,
    manga,
    binding: seededBinding,
    ...(await seedFollowed(fake, manga, options)),
  };
};

/** Another followed title on a running fake, bound to `anilistId`. */
const seedTitle = async (
  fake: FakeProgressSuwayomi,
  manga: FakeDispatchManga,
  anilistId: number,
  options: SeedOptions = {}
) => {
  await seedDispatchBinding(manga, {
    anilistId,
    instanceId: options.instanceId ?? 1,
  });
  return seedFollowed(fake, manga, { anilistId, ...options });
};

/** A run's counts: one check and nothing else unless `partial` says so. */
const ran = (partial: Partial<MangaFollowCounts> = {}): MangaFollowCounts => ({
  checked: 1,
  added: 0,
  reopened: 0,
  stopped: 0,
  paused: 0,
  enqueued: 0,
  instancesFailed: 0,
  ...partial,
});

const manifestOf = (requestId: number) =>
  getRepository(MangaRequestManifest).findOneByOrFail({ requestId });

const rowsOf = async (requestId: number) => {
  const { id } = await manifestOf(requestId);
  return getRepository(MangaRequestChapter).find({
    where: { manifestId: id },
    order: { id: 'ASC' },
  });
};

const numbersOf = async (requestId: number) =>
  (await rowsOf(requestId)).map(({ chapterNumber }) => chapterNumber);

const statusOf = async (requestId: number) =>
  (await getRepository(MediaRequest).findOneByOrFail({ id: requestId })).status;

const mediaStatusOf = async (id: number) =>
  (await getRepository(Media).findOneByOrFail({ id })).status;

/** Stage, attempt and message of each status event of a request. */
const eventsOf = async (requestId: number) =>
  (
    await getRepository(MediaRequestStatusEvent).find({
      where: { requestId },
      order: { id: 'ASC' },
    })
  ).map(({ stage, attempt, message }) => [stage, attempt, message ?? null]);

const setStatus = (id: number, status: MediaRequestStatus) =>
  dataSource
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status })
    .where({ id })
    .callListeners(false)
    .execute();

const setManifest = (
  requestId: number,
  values: Partial<
    Pick<
      MangaRequestManifest,
      | 'followEnabled'
      | 'followNextAt'
      | 'followLastAt'
      | 'followStopReason'
      | 'bindingState'
      | 'checkpoint'
      | 'attentionCode'
      | 'attentionAt'
      | 'suwayomiMangaId'
      | 'progressSignature'
      | 'progressAt'
      | 'chaptersTotal'
      | 'chaptersVerified'
      | 'chaptersQueued'
    >
  >
) => getRepository(MangaRequestManifest).update({ requestId }, values);

const setRow = (
  row: MangaRequestChapter,
  values: Partial<
    Pick<
      MangaRequestChapter,
      'deliverableAt' | 'lastQueueState' | 'missingSince' | 'followAddedAt'
    >
  >
) => getRepository(MangaRequestChapter).update(row.id, values);

/** Every row delivered, with the counts a finished poll leaves. */
const deliverAll = async (requestId: number) => {
  const now = new Date();
  const rows = await rowsOf(requestId);
  for (const row of rows) {
    await setRow(row, {
      deliverableAt: now,
      lastQueueState: MangaChapterQueueState.DOWNLOADED,
    });
  }
  await setManifest(requestId, {
    chaptersTotal: rows.length,
    chaptersVerified: rows.length,
    chaptersQueued: 0,
    progressSignature: 'delivered',
    progressAt: now,
  });
};

/** Makes a followed manifest due now. */
const makeDue = (requestId: number) =>
  setManifest(requestId, { followNextAt: null });

const ownedChapterUrls = async () =>
  (
    await getRepository(MangaChapterOwnership).find({ order: { id: 'ASC' } })
  ).map(({ chapterUrl }) => chapterUrl);

const chapterUrls = (mangaId: number, numbers: readonly number[]) =>
  numbers.map((number) => fakeChapterUrl(mangaId, number));

/** The chapter IDs of each EnqueueChapters call `fake` received. */
const enqueuedBatches = (fake: FakeProgressSuwayomi) =>
  fake.server
    .operations('EnqueueChapters')
    .map(({ variables }) =>
      (Array.isArray(variables.ids) ? variables.ids : []).map(Number)
    );

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** `at` lies `ms` after a moment between `before` and `after`. */
const assertWait = (
  at: Date | null | undefined,
  ms: number,
  before: number,
  after: number
) => {
  assert.ok(at, 'No next check was set');
  const time = at.getTime();
  assert.ok(
    time >= before + ms - 1_000 && time <= after + ms + 1_000,
    `The next check came ${time - before} ms on, not ${ms} ms`
  );
};

/** Log lines name codes, counts and IDs: never a URL, title or marker. */
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
    ...fakes.flatMap(
      (fake) => fake.state.globalMeta.get(INSTANCE_MARKER_KEY) ?? []
    ),
  ];
  for (const secret of [
    FAKE_URL_PREFIX,
    FAKE_TITLE_PREFIX,
    'Fake Chapter',
    'Fake Group',
    'com.example',
    ...markers,
  ]) {
    assert.ok(!text.includes(secret), `A log line carried ${secret}`);
  }
};

/** The fake saw only allowed reads and writes, and no manga refresh. */
const assertFollowTraffic = (fake: FakeProgressSuwayomi) => {
  assertProgressTraffic(fake.server, allowed);
  for (const { variables } of fake.server.operations('FetchMangaAndChapters')) {
    assert.strictEqual(variables.fetchManga, false);
  }
  if (!heads) assert.deepStrictEqual(fake.headIds(), []);
};

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  configure();
  logs = captureLogs();
  intents = [];
  mock.method(
    notificationManager,
    'sendNotificationIntent',
    async (type: Notification, intent: unknown) => {
      intents.push({ type, intent });
    }
  );
  downloadTracker.pruneMangaProgress(new Map());
  clients.clear();
});

afterEach(async () => {
  try {
    await waitForBackgroundTasks();
    for (const fake of fakes) {
      assertFollowTraffic(fake);
    }
    if (!announcing) assert.deepStrictEqual(intents, []);
    await assertPrivateLogs();
  } finally {
    allowed = FOLLOW_OPERATIONS;
    heads = false;
    announcing = false;
    mock.restoreAll();
    settings.main.enabledMediaCategories = categories;
    configure();
    downloadTracker.pruneMangaProgress(new Map());
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

const ALL: MangaRequestScopeValue = {
  scope: MangaRequestScope.ALL_AT_DISPATCH,
  latestCount: null,
  rangeStart: null,
  rangeEnd: null,
};

const latest = (latestCount: number): MangaRequestScopeValue => ({
  ...ALL,
  scope: MangaRequestScope.LATEST_N,
  latestCount,
});

const between = (
  rangeStart: number | null,
  rangeEnd: number | null
): MangaRequestScopeValue => ({
  ...ALL,
  scope: MangaRequestScope.RANGE,
  rangeStart,
  rangeEnd,
});

/** A source chapter numbered `chapterNumber`, at a URL of its own. */
const candidate = (
  chapterNumber: number | null,
  overrides: Partial<MangaChapterCandidate> = {}
): MangaChapterCandidate => ({
  url: `/c/${String(chapterNumber)}`,
  chapterNumber,
  ...overrides,
});

const candidates = (...numbers: number[]) =>
  numbers.map((number) => candidate(number));

/** Manifest rows for `numbers`, at their candidates' URLs. */
const rowsFor = (...numbers: (number | null)[]) =>
  numbers.map((chapterNumber) => ({
    chapterNumber,
    urlHash: hashMangaSourceUrl(candidate(chapterNumber).url),
  }));

const picked = (selection: { add: MangaChapterCandidate[] }) =>
  selection.add.map(({ chapterNumber }) => chapterNumber);

describe('selectMangaFollowChapters', () => {
  it('adds every known number the manifest lacks, in number order', () => {
    const selection = selectMangaFollowChapters({
      scope: ALL,
      rows: rowsFor(1, 2, 4),
      chapters: candidates(6, 5, 4, 3, 2, 1),
    });

    assert.deepStrictEqual(picked(selection), [3, 5, 6]);
    assert.deepStrictEqual(
      { ...selection, add: undefined },
      {
        add: undefined,
        remaining: 0,
        limitReached: false,
        rangeComplete: false,
      }
    );
  });

  it('adds only numbers above the highest in a latest-chapters manifest', () => {
    assert.deepStrictEqual(
      picked(
        selectMangaFollowChapters({
          scope: latest(2),
          rows: rowsFor(3, 4),
          chapters: candidates(1, 2, 3, 4, 5, 6),
        })
      ),
      [5, 6]
    );
  });

  it('adds what a range admits, without an end when it has none', () => {
    const open = selectMangaFollowChapters({
      scope: between(2, null),
      rows: rowsFor(2, 3),
      chapters: candidates(1, 2, 3, 4, 5, 6),
    });
    assert.deepStrictEqual(picked(open), [4, 5, 6]);
    assert.strictEqual(open.rangeComplete, false);

    assert.deepStrictEqual(
      picked(
        selectMangaFollowChapters({
          scope: between(null, 2),
          rows: rowsFor(1),
          chapters: candidates(0, 1, 2, 3),
        })
      ),
      [0, 2]
    );
  });

  it('completes a closed range once its end is listed and all of it is in', () => {
    const scope = between(2, 5);
    const before = selectMangaFollowChapters({
      scope,
      rows: rowsFor(2, 3),
      chapters: candidates(1, 2, 3, 4),
    });
    assert.deepStrictEqual(picked(before), [4]);
    assert.strictEqual(before.rangeComplete, false);

    const listed = selectMangaFollowChapters({
      scope,
      rows: rowsFor(2, 3),
      chapters: candidates(1, 2, 3, 4, 5, 6),
    });
    assert.deepStrictEqual(picked(listed), [4, 5]);
    assert.strictEqual(listed.rangeComplete, true);

    const capped = selectMangaFollowChapters({
      scope,
      rows: rowsFor(2, 3),
      chapters: candidates(1, 2, 3, 4, 5, 6),
      rowsPerCheck: 1,
    });
    assert.deepStrictEqual(picked(capped), [4]);
    assert.strictEqual(capped.remaining, 1);
    assert.strictEqual(capped.rangeComplete, false);

    const covered = selectMangaFollowChapters({
      scope,
      rows: rowsFor(2, 3, 4, 5),
      chapters: candidates(5, 6),
    });
    assert.deepStrictEqual(picked(covered), []);
    assert.strictEqual(covered.rangeComplete, true);
  });

  it('treats a number any row has as covered, whatever the URL', () => {
    assert.deepStrictEqual(
      picked(
        selectMangaFollowChapters({
          scope: ALL,
          rows: rowsFor(1, 2),
          chapters: [candidate(2, { url: '/c/2-again' }), candidate(3)],
        })
      ),
      [3]
    );
  });

  it('never adds a chapter of unknown number', () => {
    assert.deepStrictEqual(
      picked(
        selectMangaFollowChapters({
          scope: ALL,
          rows: rowsFor(1),
          chapters: [
            candidate(null),
            candidate(-1),
            candidate(NaN),
            candidate(Infinity),
            candidate(2),
          ],
        })
      ),
      [2]
    );

    // A row of unknown number covers nothing and sets no highest number.
    assert.deepStrictEqual(
      picked(
        selectMangaFollowChapters({
          scope: latest(1),
          rows: rowsFor(-1),
          chapters: candidates(1, 2),
        })
      ),
      [1, 2]
    );
  });

  it('skips a URL it cannot store and a URL the manifest holds', () => {
    const longest = `/${'x'.repeat(2_047)}`;
    assert.deepStrictEqual(
      picked(
        selectMangaFollowChapters({
          scope: ALL,
          rows: rowsFor(1),
          chapters: [
            candidate(2, { url: '' }),
            candidate(3, { url: `${longest}y` }),
            candidate(4, { url: longest }),
            candidate(5, { url: '/c/1' }),
          ],
        })
      ),
      [4]
    );
  });

  it('picks one chapter per number by scanlator preference, then upload', () => {
    const chapters = [
      candidate(2, { url: '/c/2/a', scanlator: 'Group A', uploadDate: 2 }),
      candidate(2, { url: '/c/2/b', scanlator: 'Group B', uploadDate: 1 }),
      candidate(3, { url: '/c/3/b', uploadDate: 5 }),
      candidate(3, { url: '/c/3/a', uploadDate: 5 }),
    ];
    const urls = (scanlatorPreference: string[]) =>
      selectMangaFollowChapters({
        scope: ALL,
        rows: rowsFor(1),
        chapters,
        scanlatorPreference,
      }).add.map(({ url }) => url);

    assert.deepStrictEqual(urls([]), ['/c/2/a', '/c/3/a']);
    assert.deepStrictEqual(urls(['Group B']), ['/c/2/b', '/c/3/a']);
  });

  it('adds at most a check’s worth and never past the manifest limit', () => {
    const select = (rowsPerCheck: number, manifestRows: number) => {
      const selection = selectMangaFollowChapters({
        scope: ALL,
        rows: rowsFor(1, 2),
        chapters: candidates(1, 2, 3, 4, 5),
        rowsPerCheck,
        manifestRows,
      });
      return [picked(selection), selection.remaining, selection.limitReached];
    };

    assert.deepStrictEqual(select(1, 10), [[3], 2, false]);
    assert.deepStrictEqual(select(10, 5), [[3, 4, 5], 0, false]);
    assert.deepStrictEqual(select(10, 4), [[3, 4], 1, true]);
    assert.deepStrictEqual(select(10, 2), [[], 3, true]);
    assert.deepStrictEqual(select(10, 1), [[], 3, true]);
  });
});

const label = 'Manga Follow';

/** Replaces some calls of instance `instanceId`'s client. */
const wrapClient = (
  overrides: (base: MangaFollowClient) => Partial<MangaFollowClient>,
  instanceId = 1
) => {
  const base = clients.get(instanceId);
  assert.ok(base, `No client for instance ${instanceId}`);
  clients.set(instanceId, clientWith(base, overrides(base)));
};

/** Adds chapters `numbers` to manga `mangaId` on `fake`. */
const publish = (
  fake: FakeProgressSuwayomi,
  mangaId: number,
  ...numbers: number[]
) => {
  for (const chapterNumber of numbers) {
    fake.addChapter(
      mangaId,
      chapterOf({ id: mangaId * 100 + chapterNumber, chapterNumber })
    );
  }
};

describe('runMangaFollow: checks', () => {
  it('adds new chapters to the frozen manifest and queues them as dispatch does', async () => {
    const { fake, requestId, manifest, media } = await setup();
    await setManifest(requestId, { progressSignature: 'seen' });
    publish(fake, 11, 3, 4);

    const before = Date.now();
    assert.deepStrictEqual(await follow(), ran({ added: 2, enqueued: 2 }));
    const after = Date.now();

    assert.deepStrictEqual(fake.operationNames(), CHECK_AND_QUEUE);
    assert.deepStrictEqual(enqueuedBatches(fake), [[1103, 1104]]);
    assert.deepStrictEqual(fake.state.queue, [1102, 1103, 1104]);
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2, 3, 4]);
    assert.deepStrictEqual(
      (await rowsOf(requestId)).map(({ followAddedAt }) => !!followAddedAt),
      [false, false, true, true]
    );
    assert.deepStrictEqual(
      await ownedChapterUrls(),
      chapterUrls(11, [1, 2, 3, 4])
    );
    const followed = await manifestOf(requestId);
    assertWait(
      followed.followNextAt,
      MANGA_FOLLOW_WAIT_MS.ongoing,
      before,
      after
    );
    assert.ok(followed.followLastAt);
    assert.strictEqual(followed.followEnabled, true);
    assert.strictEqual(followed.followStopReason, null);
    assert.strictEqual(followed.chaptersTotal, 4);
    assert.strictEqual(followed.progressSignature, null);
    assert.strictEqual(followed.progressAt, null);
    assert.strictEqual(await statusOf(requestId), APPROVED);
    assert.strictEqual(await mediaStatusOf(media.id), MediaStatus.PROCESSING);
    assert.deepStrictEqual(logged('Manga follow added chapters'), [
      [
        'info',
        {
          label,
          requestId,
          manifestId: manifest.id,
          count: 2,
          reopened: false,
        },
      ],
    ]);
  });

  it('changes nothing but the next check when the source lists nothing new', async () => {
    const { fake, requestId } = await setup();
    await setManifest(requestId, { progressSignature: 'seen' });

    const before = Date.now();
    assert.deepStrictEqual(await follow(), ran());
    const after = Date.now();

    assert.deepStrictEqual(fake.operationNames(), [
      'InstanceMarker',
      'FetchMangaAndChapters',
    ]);
    const manifest = await manifestOf(requestId);
    assert.strictEqual(manifest.progressSignature, 'seen');
    assertWait(
      manifest.followNextAt,
      MANGA_FOLLOW_WAIT_MS.ongoing,
      before,
      after
    );
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
    assert.deepStrictEqual(logged('Manga follow added chapters'), []);

    assert.deepStrictEqual(await follow(), ran({ checked: 0 }));
    assert.strictEqual(fake.operationNames().length, 2);
  });

  it('retries a failed enqueue at the next check without queueing twice', async () => {
    const { fake, requestId, manifest } = await setup();
    publish(fake, 11, 3);
    fake.fault('EnqueueChapters', 'error');

    const before = Date.now();
    assert.deepStrictEqual(await follow(), ran({ added: 1 }));
    const after = Date.now();
    assert.deepStrictEqual(logged('Manga follow skipped a manga'), [
      [
        'warn',
        {
          label,
          instanceId: 1,
          requestId,
          manifestId: manifest.id,
          suwayomiCode: 'UPSTREAM_ERROR',
          operation: 'EnqueueChapters',
        },
      ],
    ]);
    assertWait(
      (await manifestOf(requestId)).followNextAt,
      HOUR_MS,
      before,
      after
    );
    assert.deepStrictEqual(fake.state.queue, [1102]);

    await makeDue(requestId);
    assert.deepStrictEqual(await follow(), ran({ enqueued: 1 }));
    assert.deepStrictEqual(fake.state.queue, [1102, 1103]);

    await makeDue(requestId);
    assert.deepStrictEqual(await follow(), ran());
    assert.strictEqual(fake.server.operations('EnqueueChapters').length, 2);
    assert.deepStrictEqual(fake.state.queue, [1102, 1103]);
    assert.deepStrictEqual(
      await ownedChapterUrls(),
      chapterUrls(11, [1, 2, 3])
    );
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2, 3]);
  });

  it('warns once about followed chapters Suwayomi no longer lists', async () => {
    const { fake, requestId, manifest } = await setup();
    publish(fake, 11, 3);
    wrapClient(() => ({ getChaptersToDownload: async () => [] }));

    assert.deepStrictEqual(await follow(), ran({ added: 1 }));
    const unmapped = [
      [
        'warn',
        {
          label,
          requestId,
          manifestId: manifest.id,
          code: 'MANGA_FOLLOW_CHAPTERS_UNMAPPED',
          count: 1,
        },
      ],
    ];
    assert.deepStrictEqual(
      logged('Followed manga chapters Suwayomi no longer lists'),
      unmapped
    );

    // The progress poll reports a chapter it marked missing.
    const [, , added] = await rowsOf(requestId);
    await setRow(added, { missingSince: new Date() });
    await makeDue(requestId);
    assert.deepStrictEqual(await follow(), ran());
    assert.deepStrictEqual(
      logged('Followed manga chapters Suwayomi no longer lists'),
      unmapped
    );
    assert.deepStrictEqual(fake.server.operations('EnqueueChapters'), []);
  });

  it('queues at most 50 chapters per call', async () => {
    const { fake, requestId } = await setup();
    publish(fake, 11, ...range(3, 99));

    assert.deepStrictEqual(await follow(), ran({ added: 97, enqueued: 97 }));
    assert.deepStrictEqual(
      enqueuedBatches(fake).map((ids) => ids.length),
      [50, 47]
    );
    assert.deepStrictEqual(fake.enqueuedIds(), range(1103, 1199));
    assert.strictEqual((await rowsOf(requestId)).length, 99);
  });

  it('leaves chapters past the per-check bound to a check within the hour', async () => {
    const { fake, requestId } = await setup();
    publish(fake, 11, 3, 4, 5);
    const limits = { rowsPerCheck: 2 };

    const before = Date.now();
    assert.deepStrictEqual(
      await follow({ limits }),
      ran({ added: 2, enqueued: 2 })
    );
    const after = Date.now();
    assertWait(
      (await manifestOf(requestId)).followNextAt,
      HOUR_MS,
      before,
      after
    );

    await makeDue(requestId);
    assert.deepStrictEqual(
      await follow({ limits }),
      ran({ added: 1, enqueued: 1 })
    );
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(fake.enqueuedIds(), [1103, 1104, 1105]);
  });

  it('adds and queues each chapter once when two runs check together', async () => {
    const { fake, requestId } = await setup();
    publish(fake, 11, 3);

    const [first, second] = await Promise.all([follow(), follow()]);

    assert.strictEqual(first.added + second.added, 1);
    assert.strictEqual(first.enqueued + second.enqueued, 1);
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2, 3]);
    assert.deepStrictEqual(fake.enqueuedIds(), [1103]);
    assert.deepStrictEqual(
      await ownedChapterUrls(),
      chapterUrls(11, [1, 2, 3])
    );
  });

  it('never adds a number the manifest has, nor a URL it holds, nor an unknown number', async () => {
    const { fake, requestId } = await setup();
    const [first] = await rowsOf(requestId);
    await setRow((await rowsOf(requestId))[1], { missingSince: new Date() });
    const manga = fake.manga(11);
    manga.chapters = manga.chapters.filter(({ id }) => id !== 1102);
    // Chapter 2, which the poll found missing, back at another URL.
    fake.addChapter(
      11,
      chapterOf({
        id: 1150,
        chapterNumber: 2,
        url: `${fakeChapterUrl(11, 2)}/again`,
      })
    );
    // Row 1's chapter, numbered anew.
    const renumbered = manga.chapters.find(({ url }) => url === first.url);
    assert.ok(renumbered);
    renumbered.chapterNumber = 7;
    fake.addChapter(11, chapterOf({ id: 1160, chapterNumber: -1 }));

    assert.deepStrictEqual(await follow(), ran());
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
    assert.deepStrictEqual(fake.server.operations('EnqueueChapters'), []);
  });
});

describe('runMangaFollow: conditions inside the write', () => {
  const cases: {
    name: string;
    change: (seeded: {
      requestId: number;
      binding?: MangaSourceBinding;
    }) => Promise<unknown>;
    counts: Partial<MangaFollowCounts>;
    enabled: boolean;
    reason: MangaFollowStopReason | null;
  }[] = [
    {
      name: 'following turned off',
      change: ({ requestId }) =>
        setManifest(requestId, { followEnabled: false }),
      counts: {},
      enabled: false,
      reason: null,
    },
    {
      name: 'the request declined',
      change: ({ requestId }) => setStatus(requestId, DECLINED),
      counts: { stopped: 1 },
      enabled: false,
      reason: MangaFollowStopReason.REQUEST_DECLINED,
    },
    {
      name: 'the binding orphaned',
      change: ({ binding }) =>
        getRepository(MangaSourceBinding).update(binding?.id ?? 0, {
          state: MangaBindingState.ORPHANED,
        }),
      counts: { paused: 1 },
      enabled: true,
      reason: MangaFollowStopReason.BINDING_INACTIVE,
    },
  ];

  for (const { name, change, counts, enabled, reason } of cases) {
    it(`adds nothing once ${name} during the check`, async () => {
      const seeded = await setup();
      const { fake, requestId } = seeded;
      publish(fake, 11, 3);

      assert.deepStrictEqual(
        await follow({
          anilistStatus: async () => {
            await change(seeded);
            return undefined;
          },
        }),
        ran({ checked: 0, ...counts })
      );

      assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
      assert.deepStrictEqual(fake.server.operations('EnqueueChapters'), []);
      const manifest = await manifestOf(requestId);
      assert.strictEqual(manifest.followEnabled, enabled);
      assert.strictEqual(manifest.followStopReason, reason);
    });
  }
});

describe('runMangaFollow: lock order', () => {
  it('calls Suwayomi and AniList holding nothing, and takes no admission under the lock', async () => {
    const { fake, requestId } = await setup();
    publish(fake, 11, 3);
    const depth = {
      transaction: 0,
      instance: 0,
      request: 0,
      edit: 0,
      media: 0,
    };
    const held = () => Object.values(depth).some((count) => count > 0);
    const entries: { name: string; locked: boolean }[] = [];
    const enter = (name: string) =>
      entries.push({ name, locked: isInsideMangaFollowLock() });

    const transaction = dataSource.transaction.bind(dataSource) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const transactions = mock.method(
      dataSource,
      'transaction',
      async (...args: unknown[]) => {
        depth.transaction += 1;
        try {
          return await transaction(...args);
        } finally {
          depth.transaction -= 1;
        }
      }
    );
    const instanceOriginal = instanceAdmission.runWithSuwayomiInstanceAdmission;
    mock.method(instanceAdmission, 'runWithSuwayomiInstanceAdmission', (async (
      snapshot,
      callback
    ) => {
      enter('instance');
      depth.instance += 1;
      try {
        return await instanceOriginal(snapshot, callback);
      } finally {
        depth.instance -= 1;
      }
    }) as typeof instanceOriginal);
    const requestOriginal = mediaRequestModule.runWithRequestAdmission;
    const request = mock.method(
      mediaRequestModule,
      'runWithRequestAdmission',
      (async (keys, callback) => {
        enter('request');
        const edit = keys.some((key) => key.startsWith('request-edit:'))
          ? 1
          : 0;
        depth.request += 1;
        depth.edit += edit;
        try {
          return await requestOriginal(keys, callback);
        } finally {
          depth.request -= 1;
          depth.edit -= edit;
        }
      }) as typeof requestOriginal
    );
    const mediaOriginal = mediaMutation.runMediaEntityMutation;
    const media = mock.method(mediaMutation, 'runMediaEntityMutation', (async (
      target,
      callback
    ) => {
      enter('media');
      depth.media += 1;
      try {
        return await mediaOriginal(target, callback);
      } finally {
        depth.media -= 1;
      }
    }) as typeof mediaOriginal);
    const inside: string[] = [];
    fake.observe((sent) => {
      if (held()) inside.push(sent.operationName ?? sent.method);
    });

    assert.deepStrictEqual(
      await follow({
        anilistStatus: async () => {
          if (held() || isInsideMangaFollowLock()) inside.push('AniList');
          return 'RELEASING';
        },
      }),
      ran({ added: 1, enqueued: 1 })
    );

    assert.deepStrictEqual(await numbersOf(requestId), [1, 2, 3]);
    assert.deepStrictEqual(inside, []);
    assert.deepStrictEqual(
      entries.filter(({ locked }) => locked),
      [],
      'an admission was entered under the dispatch lock'
    );
    assert.strictEqual(media.mock.callCount(), 0);
    assert.ok(request.mock.callCount() > 0);
    assert.ok(transactions.mock.callCount() > 0);
  });
});

const setMediaStatus = (id: number, status: MediaStatus) =>
  dataSource
    .createQueryBuilder()
    .update(Media)
    .set({ status })
    .where({ id })
    .callListeners(false)
    .execute();

/** Downloads chapters `numbers` of a manga, off the queue. */
const downloadChapter = (
  fake: FakeProgressSuwayomi,
  mangaId: number,
  ...numbers: number[]
) => {
  for (const chapter of fake.manga(mangaId).chapters) {
    if (!numbers.includes(chapter.chapterNumber)) continue;
    chapter.isDownloaded = true;
    fake.state.queue = fake.state.queue.filter((id) => id !== chapter.id);
    fake.queueItems.delete(chapter.id);
  }
};

/** The MEDIA_AVAILABLE intents queued so far. */
const announced = async () => {
  await waitForBackgroundTasks();
  return intents.filter(({ type }) => type === Notification.MEDIA_AVAILABLE);
};

/** A request whose every chapter was delivered and that completed. */
const setupCompleted = async () => {
  const seeded = await setup(mangaWith(11, [1, 2], [1, 2]));
  await deliverAll(seeded.requestId);
  await setStatus(seeded.requestId, COMPLETED);
  await setMediaStatus(seeded.media.id, MediaStatus.AVAILABLE);
  return seeded;
};

const stagesOf = async (requestId: number) =>
  (await eventsOf(requestId)).map(([stage, attempt]) => [stage, attempt]);

describe('runMangaFollow: re-opening', () => {
  it('re-opens a completed request for new chapters, with no notification and no dispatch', async () => {
    const { fake, requestId, manifest, media } = await setupCompleted();
    await recordRequestStatus(requestId);
    const recorded = await eventsOf(requestId);
    assert.deepStrictEqual(recorded.at(-1)?.slice(0, 2), [
      RequestStatusStage.AVAILABLE,
      0,
    ]);
    const mutations = mock.method(mediaMutation, 'runMediaEntityMutation');
    publish(fake, 11, 3);

    assert.deepStrictEqual(
      await follow(),
      ran({ added: 1, reopened: 1, enqueued: 1 })
    );

    assert.strictEqual(await statusOf(requestId), APPROVED);
    assert.deepStrictEqual(await eventsOf(requestId), [
      ...recorded,
      [
        RequestStatusStage.APPROVED,
        1,
        'New chapters were added to this request.',
      ],
    ]);
    const status = await recordRequestStatus(requestId);
    assert.ok(status);
    assert.deepStrictEqual(
      [status.stage, status.attempt, status.percent],
      [RequestStatusStage.DOWNLOADING, 1, 66.7]
    );
    assert.deepStrictEqual(fake.enqueuedIds(), [1103]);
    assert.strictEqual(await mediaStatusOf(media.id), MediaStatus.AVAILABLE);
    assert.strictEqual(mutations.mock.callCount(), 0);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
    assert.deepStrictEqual(await findDueMangaRequestIds(50), []);
    const sent = fake.server.requests.length;
    assert.deepStrictEqual(
      await dispatchMangaRequest(await loadDispatchRequest(requestId), {
        clientFor: () => undefined,
      }),
      { delivered: true }
    );
    assert.strictEqual(fake.server.requests.length, sent);
    assert.deepStrictEqual(logged('Manga follow added chapters'), [
      [
        'info',
        {
          label,
          requestId,
          manifestId: manifest.id,
          count: 1,
          reopened: true,
        },
      ],
    ]);
  });

  it('writes no status event for an approved request', async () => {
    const { fake, requestId } = await setup();
    const events = await eventsOf(requestId);
    publish(fake, 11, 3);

    assert.deepStrictEqual(await follow(), ran({ added: 1, enqueued: 1 }));
    assert.strictEqual(await statusOf(requestId), APPROVED);
    assert.deepStrictEqual(await eventsOf(requestId), events);
  });

  it('leaves a completed request with an unresolved problem closed', async () => {
    const { fake, requestId, manifest } = await setupCompleted();
    const events = await eventsOf(requestId);
    await setManifest(requestId, {
      attentionCode: MangaAttentionCode.CHAPTER_ERROR,
      attentionAt: new Date(),
    });
    publish(fake, 11, 3);

    const before = Date.now();
    assert.deepStrictEqual(await follow(), ran());
    const after = Date.now();

    assert.strictEqual(await statusOf(requestId), COMPLETED);
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
    assert.deepStrictEqual(await eventsOf(requestId), events);
    assert.deepStrictEqual(fake.server.operations('EnqueueChapters'), []);
    assertWait(
      (await manifestOf(requestId)).followNextAt,
      MANGA_FOLLOW_WAIT_MS.ongoing,
      before,
      after
    );
    assert.deepStrictEqual(
      logged('Manga follow left a completed request closed'),
      [
        [
          'warn',
          {
            label,
            requestId,
            manifestId: manifest.id,
            code: 'MANGA_FOLLOW_REOPEN_BLOCKED',
          },
        ],
      ]
    );
  });

  it('lets the progress poll complete the request again, announcing each completion once', async () => {
    announcing = true;
    heads = true;
    allowed = new Set([...FOLLOW_OPERATIONS, 'Availability']);
    const { fake, requestId } = await setup();
    const progressClient = dispatchClientFor(fake.server);
    const poll = () => pollMangaProgress({ clientFor: () => progressClient });

    downloadChapter(fake, 11, 2);
    await poll();
    assert.strictEqual(await statusOf(requestId), COMPLETED);
    assert.strictEqual((await announced()).length, 1);

    publish(fake, 11, 3);
    assert.deepStrictEqual(
      await follow(),
      ran({ added: 1, reopened: 1, enqueued: 1 })
    );
    assert.strictEqual(await statusOf(requestId), APPROVED);
    await poll();
    assert.strictEqual(await statusOf(requestId), APPROVED);
    assert.strictEqual((await announced()).length, 1);

    downloadChapter(fake, 11, 3);
    await poll();
    assert.strictEqual(await statusOf(requestId), COMPLETED);
    await poll();
    assert.strictEqual((await announced()).length, 2);
    assert.deepStrictEqual(
      (await stagesOf(requestId)).map(([stage]) => stage),
      [
        RequestStatusStage.REQUESTED,
        RequestStatusStage.AVAILABLE,
        RequestStatusStage.APPROVED,
        RequestStatusStage.AVAILABLE,
      ]
    );
  });
});

/** The chapter IDs of each DequeueChapters call `fake` received. */
const dequeued = (fake: FakeProgressSuwayomi) =>
  fake.server
    .operations('DequeueChapters')
    .map(({ variables }) =>
      (Array.isArray(variables.ids) ? variables.ids : []).map(Number)
    );

/** The manga ID of each chapter list `fake` was asked for, in order. */
const fetchedIds = (fake: FakeProgressSuwayomi) =>
  fake.server
    .operations('FetchMangaAndChapters')
    .map(({ variables }) => Number(variables.id));

/**
 * A fake serving `mangas` as instance 1, each bound to AniList 9000 plus its
 * ID and followed by a request of its own.
 */
const setupTitles = async (mangas: FakeDispatchManga[]) => {
  const fake = await start(mangas);
  configure(dispatchInstanceFor(fake.server));
  const titles: Awaited<ReturnType<typeof seedTitle>>[] = [];
  for (const manga of mangas) {
    titles.push(await seedTitle(fake, manga, 9000 + manga.id));
  }
  return { fake, titles };
};

/** Whole hours from `from` to the manifest's next check. */
const hoursUntilCheck = async (requestId: number, from: number) => {
  const { followNextAt } = await manifestOf(requestId);
  assert.ok(followNextAt, 'No next check was set');
  return Math.round((followNextAt.getTime() - from) / HOUR_MS);
};

describe('runMangaFollow: release', () => {
  it('keeps followed chapters queued while the request is approved, and releases them once declined', async () => {
    allowed = DISPATCH_ALLOWED_OPERATIONS;
    const manga = mangaWith(11, [1, 2]);
    const fake = await start([manga]);
    configure(dispatchInstanceFor(fake.server));
    await seedDispatchBinding(manga);
    const { request } = await seedDispatchRequest({
      manifest: { followEnabled: true },
    });
    await forgetSeeding(request.id);
    const client = dispatchClientFor(fake.server);
    assert.deepStrictEqual(
      await dispatchMangaRequest(await loadDispatchRequest(request.id), {
        clientFor: () => client,
      }),
      { delivered: true }
    );
    downloadChapter(fake, 11, 1, 2);
    publish(fake, 11, 3, 4);
    // The owner queued chapter 4 themselves: it stays theirs.
    fake.state.queue.push(1104);

    assert.deepStrictEqual(await follow(), ran({ added: 2, enqueued: 1 }));
    assert.deepStrictEqual(enqueuedBatches(fake), [[1101, 1102], [1103]]);
    assert.deepStrictEqual(
      await ownedChapterUrls(),
      chapterUrls(11, [1, 2, 3])
    );

    await releaseMangaDispatch({ clientFor: () => client });
    assert.deepStrictEqual(dequeued(fake), []);
    assert.deepStrictEqual(
      await ownedChapterUrls(),
      chapterUrls(11, [1, 2, 3])
    );

    await setStatus(request.id, DECLINED);
    await releaseMangaDispatch({ clientFor: () => client });
    assert.deepStrictEqual(dequeued(fake), [[1103]]);
    assert.deepStrictEqual(fake.state.queue, [1104]);
    assert.deepStrictEqual(await ownedChapterUrls(), []);
  });
});

describe('runMangaFollow: due checks', () => {
  it('checks the longest due first, within the bounds per source and instance', async () => {
    const other = '1003';
    const { fake, titles } = await setupTitles([
      mangaWith(11, [1], [1]),
      mangaWith(12, [1], [1]),
      mangaWith(13, [1], [1]),
      libraryManga(14, {
        sourceId: other,
        chapters: fakeDispatchChapters(14, [1], [1]),
      }),
      libraryManga(15, {
        sourceId: other,
        chapters: fakeDispatchChapters(15, [1], [1]),
      }),
    ]);
    const now = Date.now();
    const offsets = [null, -3 * HOUR_MS, -HOUR_MS, -2 * HOUR_MS, -HOUR_MS / 2];
    for (const [index, { requestId }] of titles.entries()) {
      const offset = offsets[index];
      await setManifest(requestId, {
        followNextAt: offset === null ? null : new Date(now + offset),
      });
    }

    assert.deepStrictEqual(
      await follow({ limits: { perSource: 2, perInstance: 3 } }),
      ran({ checked: 3 })
    );

    assert.deepStrictEqual(fetchedIds(fake), [11, 12, 14]);
    for (const { requestId } of [titles[2], titles[4]]) {
      const { followNextAt } = await manifestOf(requestId);
      assert.ok(followNextAt && followNextAt.getTime() < Date.now());
    }
  });

  it('checks no manifest that is off, not due, not dispatched or not approved', async () => {
    const { fake, titles } = await setupTitles([
      mangaWith(11, [1], [1]),
      mangaWith(12, [1], [1]),
      mangaWith(13, [1], [1]),
      mangaWith(14, [1], [1]),
    ]);
    const [off, later, frozen, pending] = titles;
    await setManifest(off.requestId, { followEnabled: false });
    await setManifest(later.requestId, {
      followNextAt: new Date(Date.now() + HOUR_MS),
    });
    await setManifest(frozen.requestId, {
      checkpoint: MangaRequestCheckpoint.MANIFEST_FROZEN,
    });
    await setStatus(pending.requestId, PENDING);

    assert.deepStrictEqual(await follow(), ran({ checked: 0 }));
    assert.deepStrictEqual(fake.server.requests, []);
  });
});

describe('runMangaFollow: failures', () => {
  it('stops on an unreachable instance, leaving its checks due, and goes on to the next', async () => {
    const first = await start([
      mangaWith(11, [1], [1]),
      mangaWith(12, [1], [1]),
    ]);
    const second = await start([mangaWith(21, [1], [1])], 2);
    configure(
      dispatchInstanceFor(first.server),
      dispatchInstanceFor(second.server, 2)
    );
    const stalled = [
      await seedTitle(first, first.manga(11), 9011),
      await seedTitle(first, first.manga(12), 9012),
    ];
    const checked = await seedTitle(second, second.manga(21), 9021, {
      instanceId: 2,
    });
    wrapClient(() => ({
      fetchMangaAndChapters: async () => {
        throw new SuwayomiError('UNREACHABLE', 'FetchMangaAndChapters');
      },
    }));

    assert.deepStrictEqual(await follow(), ran({ instancesFailed: 1 }));

    assert.deepStrictEqual(first.operationNames(), ['InstanceMarker']);
    assert.deepStrictEqual(fetchedIds(second), [21]);
    for (const { requestId } of stalled) {
      assert.strictEqual((await manifestOf(requestId)).followNextAt, null);
    }
    assert.notStrictEqual(
      (await manifestOf(checked.requestId)).followNextAt,
      null
    );
    assert.deepStrictEqual(logged('Manga follow stopped on an instance'), [
      [
        'warn',
        {
          label,
          instanceId: 1,
          suwayomiCode: 'UNREACHABLE',
          operation: 'FetchMangaAndChapters',
        },
      ],
    ]);
  });

  it('checks again within the hour when the refresh returns no fresh list', async () => {
    const { fake, requestId, manifest } = await setup();
    publish(fake, 11, 3);
    fake.fault('FetchMangaAndChapters', 'partial');

    const before = Date.now();
    assert.deepStrictEqual(await follow(), ran({ checked: 0 }));
    const after = Date.now();

    assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
    assert.deepStrictEqual(fake.enqueuedIds(), []);
    assertWait(
      (await manifestOf(requestId)).followNextAt,
      MANGA_FOLLOW_WAIT_MS.retry,
      before,
      after
    );
    assert.deepStrictEqual(logged('Manga follow found no fresh chapter list'), [
      [
        'warn',
        {
          label,
          requestId,
          manifestId: manifest.id,
          code: 'MANGA_FOLLOW_LIST_STALE',
          issue: 'UPSTREAM_ERROR',
        },
      ],
    ]);
  });

  it('checks again within the hour when the refresh times out', async () => {
    allowed = new Set([...FOLLOW_OPERATIONS, 'MangaDetails']);
    const { fake, requestId, manifest } = await setup();
    clients.set(1, dispatchClientFor(fake.server, { source: 200 }));
    publish(fake, 11, 3);
    fake.fault('FetchMangaAndChapters', 'hang');

    const before = Date.now();
    assert.deepStrictEqual(await follow(), ran({ checked: 0 }));
    const after = Date.now();

    assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
    assertWait(
      (await manifestOf(requestId)).followNextAt,
      MANGA_FOLLOW_WAIT_MS.retry,
      before,
      after
    );
    assert.deepStrictEqual(logged('Manga follow found no fresh chapter list'), [
      [
        'warn',
        {
          label,
          requestId,
          manifestId: manifest.id,
          code: 'MANGA_FOLLOW_LIST_STALE',
          issue: 'TIMEOUT',
        },
      ],
    ]);
  });
});

describe('runMangaFollow: resolving the manga', () => {
  it('finds the manga again when Suwayomi no longer has the cached ID', async () => {
    const { fake, requestId } = await setup();
    await setManifest(requestId, { suwayomiMangaId: 99 });
    publish(fake, 11, 3);

    assert.deepStrictEqual(await follow(), ran({ added: 1, enqueued: 1 }));

    assert.deepStrictEqual(fetchedIds(fake), [99, 11]);
    assert.strictEqual((await manifestOf(requestId)).suwayomiMangaId, 11);
    assert.deepStrictEqual(enqueuedBatches(fake), [[1103]]);
  });

  it('finds the manga again when the cached ID names another manga', async () => {
    const { fake, requestId } = await setup();
    fake.state.mangas.push(mangaWith(12, [1, 2, 3, 4]));
    await setManifest(requestId, { suwayomiMangaId: 12 });
    publish(fake, 11, 3);

    assert.deepStrictEqual(await follow(), ran({ added: 1, enqueued: 1 }));

    assert.deepStrictEqual(fetchedIds(fake), [12, 11]);
    assert.strictEqual((await manifestOf(requestId)).suwayomiMangaId, 11);
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2, 3]);
    assert.deepStrictEqual(enqueuedBatches(fake), [[1103]]);
  });

  it('skips the manga for an hour when its own refresh fails', async () => {
    const { fake, requestId, manifest } = await setup();
    publish(fake, 11, 3);
    fake.fault('FetchMangaAndChapters', 'error');

    const before = Date.now();
    assert.deepStrictEqual(await follow(), ran({ checked: 0 }));
    const after = Date.now();

    assert.deepStrictEqual(fetchedIds(fake), [11]);
    assert.strictEqual(fake.server.operations('ByNaturalKey').length, 1);
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
    assertWait(
      (await manifestOf(requestId)).followNextAt,
      MANGA_FOLLOW_WAIT_MS.retry,
      before,
      after
    );
    assert.deepStrictEqual(logged('Manga follow skipped a manga'), [
      [
        'warn',
        {
          label,
          instanceId: 1,
          requestId,
          manifestId: manifest.id,
          suwayomiCode: 'UPSTREAM_ERROR',
          operation: 'FetchMangaAndChapters',
        },
      ],
    ]);
  });

  it('pauses following for a day when Suwayomi no longer has the manga', async () => {
    const { fake, requestId, manifest } = await setup();
    fake.state.mangas = [];

    const before = Date.now();
    assert.deepStrictEqual(await follow(), ran({ checked: 0, paused: 1 }));
    const after = Date.now();

    const current = await manifestOf(requestId);
    assert.strictEqual(current.followEnabled, true);
    assert.strictEqual(
      current.followStopReason,
      MangaFollowStopReason.MANGA_NOT_FOUND
    );
    assertWait(
      current.followNextAt,
      MANGA_FOLLOW_WAIT_MS.paused,
      before,
      after
    );
    assert.deepStrictEqual(logged('Manga follow paused'), [
      [
        'info',
        {
          label,
          requestId,
          manifestId: manifest.id,
          code: MangaFollowStopReason.MANGA_NOT_FOUND,
        },
      ],
    ]);
  });
});

describe('runMangaFollow: cadence', () => {
  it('spaces checks by publication status, AniList’s before the source’s', async () => {
    const ongoing = 8;
    const hiatus = 7 * 24;
    const finished = 30 * 24;
    const cases: {
      id: number;
      anilist?: AnilistMangaStatus | 'fails';
      source?: SuwayomiMangaStatus;
      delivered?: boolean;
      missing?: boolean;
      hours: number;
    }[] = [
      { id: 11, anilist: 'RELEASING', hours: ongoing },
      { id: 12, anilist: 'HIATUS', hours: hiatus },
      { id: 13, anilist: 'FINISHED', delivered: true, hours: finished },
      { id: 14, anilist: 'FINISHED', hours: ongoing },
      { id: 15, anilist: 'CANCELLED', delivered: true, hours: finished },
      { id: 16, source: 'ON_HIATUS', hours: hiatus },
      { id: 17, source: 'COMPLETED', delivered: true, hours: finished },
      {
        id: 18,
        source: 'PUBLISHING_FINISHED',
        delivered: true,
        hours: finished,
      },
      { id: 19, source: 'CANCELLED', delivered: true, hours: finished },
      {
        id: 20,
        anilist: 'RELEASING',
        source: 'COMPLETED',
        delivered: true,
        hours: ongoing,
      },
      {
        id: 21,
        anilist: 'fails',
        source: 'COMPLETED',
        delivered: true,
        hours: finished,
      },
      {
        id: 22,
        anilist: 'NOT_YET_RELEASED',
        source: 'ON_HIATUS',
        hours: ongoing,
      },
      {
        id: 23,
        anilist: 'FINISHED',
        delivered: true,
        missing: true,
        hours: ongoing,
      },
    ];
    const { titles } = await setupTitles(
      cases.map(({ id }) => mangaWith(id, [1], [1]))
    );
    for (const [index, { delivered, missing }] of cases.entries()) {
      const { requestId } = titles[index];
      if (delivered) await deliverAll(requestId);
      if (missing) {
        const [row] = await rowsOf(requestId);
        await setRow(row, { missingSince: new Date() });
      }
    }
    const sources = new Map(
      cases.map(({ id, source }) => [String(id), source])
    );
    wrapClient((base) => ({
      fetchMangaAndChapters: async (mangaId, options) => {
        const result = await base.fetchMangaAndChapters(mangaId, options);
        const status = sources.get(mangaId);
        return status && result.manga
          ? { ...result, manga: { ...result.manga, status } }
          : result;
      },
    }));
    const anilist = new Map(
      cases.map(({ id, anilist }) => [9000 + id, anilist])
    );

    const before = Date.now();
    assert.deepStrictEqual(
      await follow({
        anilistStatus: async (anilistId) => {
          const status = anilist.get(anilistId);
          if (status === 'fails') throw new Error('AniList failed');
          return status;
        },
        limits: { perSource: 20, perInstance: 20 },
      }),
      ran({ checked: cases.length })
    );

    const waits: [number, number][] = [];
    for (const [index, { id }] of cases.entries()) {
      waits.push([id, await hoursUntilCheck(titles[index].requestId, before)]);
    }
    assert.deepStrictEqual(
      waits,
      cases.map(({ id, hours }) => [id, hours])
    );
  });

  it('spreads the next check by up to four hours', async () => {
    const { requestId } = await setup(mangaWith(11, [1], [1]));
    const spreads: [random: number, hours: number][] = [
      [0.5, 10],
      [2, 12],
      [-1, 8],
      [Number.NaN, 8],
    ];
    for (const [random, hours] of spreads) {
      await makeDue(requestId);
      const before = Date.now();
      assert.deepStrictEqual(await follow({ random: () => random }), ran());
      const after = Date.now();
      assertWait(
        (await manifestOf(requestId)).followNextAt,
        hours * HOUR_MS,
        before,
        after
      );
    }
  });
});

describe('runMangaFollow: cancelling', () => {
  it('stops before the next check once cancelled', async () => {
    const { fake, titles } = await setupTitles([
      mangaWith(11, [1], [1]),
      mangaWith(12, [1], [1]),
    ]);
    const controller = new AbortController();

    await assert.rejects(
      follow({
        signal: controller.signal,
        anilistStatus: async () => {
          controller.abort();
          return undefined;
        },
      }),
      { name: 'AbortError' }
    );

    assert.deepStrictEqual(fetchedIds(fake), [11]);
    assert.notStrictEqual(
      (await manifestOf(titles[0].requestId)).followNextAt,
      null
    );
    assert.strictEqual(
      (await manifestOf(titles[1].requestId)).followNextAt,
      null
    );
  });
});

/** Whether following is on, why it last stopped or paused, and when next. */
const followOf = async (requestId: number) => {
  const { followEnabled, followStopReason, followNextAt } =
    await manifestOf(requestId);
  return { followEnabled, followStopReason, followNextAt };
};

const stoppedFollow = (reason: MangaFollowStopReason) => ({
  followEnabled: false,
  followStopReason: reason,
  followNextAt: null,
});

/** The info line of each stop or pause, by its message. */
const settlementLog = (
  message: 'Manga follow stopped' | 'Manga follow paused',
  requestId: number,
  manifestId: number,
  code: MangaFollowStopReason
) => [message, ['info', { label, requestId, manifestId, code }]] as const;

const assertSettled = (...expected: ReturnType<typeof settlementLog>[]) => {
  for (const message of [
    'Manga follow stopped',
    'Manga follow paused',
  ] as const) {
    assert.deepStrictEqual(
      logged(message),
      expected.flatMap(([text, entry]) => (text === message ? [entry] : []))
    );
  }
};

const range13 = {
  scope: MangaRequestScope.RANGE,
  rangeStart: 1,
  rangeEnd: 3,
} as const;

describe('runMangaFollow: stops', () => {
  it('stops following once the owner may no longer request manga', async () => {
    const { fake, requestId, manifest } = await setup();
    publish(fake, 11, 3);
    await dataSource
      .createQueryBuilder()
      .update(User)
      .set({ permissions: 0 })
      .where({ id: 2 })
      .callListeners(false)
      .execute();

    assert.deepStrictEqual(await follow(), ran({ checked: 0, stopped: 1 }));

    assert.deepStrictEqual(
      await followOf(requestId),
      stoppedFollow(MangaFollowStopReason.OWNER_NOT_PERMITTED)
    );
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
    assert.deepStrictEqual(fake.server.requests, []);
    assertSettled(
      settlementLog(
        'Manga follow stopped',
        requestId,
        manifest.id,
        MangaFollowStopReason.OWNER_NOT_PERMITTED
      )
    );
  });

  it('stops following declined and failed requests, at most a run’s worth at a time', async () => {
    const { fake, titles } = await setupTitles([
      mangaWith(11, [1], [1]),
      mangaWith(12, [1], [1]),
      mangaWith(13, [1], [1]),
    ]);
    const later = new Date(Date.now() + DAY_MS);
    for (const { requestId } of titles) {
      await setManifest(requestId, { followNextAt: later });
    }
    const [first, second, third] = titles;
    await setStatus(first.requestId, DECLINED);
    await setStatus(second.requestId, FAILED);
    await setStatus(third.requestId, DECLINED);

    assert.deepStrictEqual(
      await follow({ limits: { stops: 2 } }),
      ran({ checked: 0, stopped: 2 })
    );
    assert.deepStrictEqual(
      await followOf(first.requestId),
      stoppedFollow(MangaFollowStopReason.REQUEST_DECLINED)
    );
    assert.deepStrictEqual(
      await followOf(second.requestId),
      stoppedFollow(MangaFollowStopReason.REQUEST_FAILED)
    );
    assert.strictEqual((await manifestOf(third.requestId)).followEnabled, true);

    assert.deepStrictEqual(await follow(), ran({ checked: 0, stopped: 1 }));
    assert.deepStrictEqual(
      await followOf(third.requestId),
      stoppedFollow(MangaFollowStopReason.REQUEST_DECLINED)
    );
    assert.deepStrictEqual(fake.server.requests, []);
    assertSettled(
      settlementLog(
        'Manga follow stopped',
        first.requestId,
        first.manifest.id,
        MangaFollowStopReason.REQUEST_DECLINED
      ),
      settlementLog(
        'Manga follow stopped',
        second.requestId,
        second.manifest.id,
        MangaFollowStopReason.REQUEST_FAILED
      ),
      settlementLog(
        'Manga follow stopped',
        third.requestId,
        third.manifest.id,
        MangaFollowStopReason.REQUEST_DECLINED
      )
    );
  });

  it('stops following a closed range once its last chapter is queued', async () => {
    const { fake, requestId, manifest } = await setup(undefined, {
      manifest: range13,
    });
    publish(fake, 11, 3, 4);

    assert.deepStrictEqual(
      await follow(),
      ran({ added: 1, enqueued: 1, stopped: 1 })
    );

    assert.deepStrictEqual(await numbersOf(requestId), [1, 2, 3]);
    assert.deepStrictEqual(enqueuedBatches(fake), [[1103]]);
    assert.deepStrictEqual(
      await followOf(requestId),
      stoppedFollow(MangaFollowStopReason.RANGE_COMPLETE)
    );
    assertSettled(
      settlementLog(
        'Manga follow stopped',
        requestId,
        manifest.id,
        MangaFollowStopReason.RANGE_COMPLETE
      )
    );
  });

  it('stops following a closed range at once when nothing is left to queue', async () => {
    const { fake, requestId, manifest } = await setup(undefined, {
      manifest: { ...range13, rangeEnd: 2 },
    });

    assert.deepStrictEqual(await follow(), ran({ stopped: 1 }));

    assert.deepStrictEqual(fake.operationNames(), [
      'InstanceMarker',
      'FetchMangaAndChapters',
    ]);
    assert.deepStrictEqual(
      await followOf(requestId),
      stoppedFollow(MangaFollowStopReason.RANGE_COMPLETE)
    );
    assertSettled(
      settlementLog(
        'Manga follow stopped',
        requestId,
        manifest.id,
        MangaFollowStopReason.RANGE_COMPLETE
      )
    );
  });

  it('stops following once the manifest is full', async () => {
    const { fake, requestId, manifest } = await setup();
    publish(fake, 11, 3, 4, 5);

    assert.deepStrictEqual(
      await follow({ limits: { manifestRows: 3 } }),
      ran({ added: 1, enqueued: 1, stopped: 1 })
    );

    assert.deepStrictEqual(await numbersOf(requestId), [1, 2, 3]);
    assert.deepStrictEqual(enqueuedBatches(fake), [[1103]]);
    assert.deepStrictEqual(
      await followOf(requestId),
      stoppedFollow(MangaFollowStopReason.MANIFEST_LIMIT)
    );
    assertSettled(
      settlementLog(
        'Manga follow stopped',
        requestId,
        manifest.id,
        MangaFollowStopReason.MANIFEST_LIMIT
      )
    );
  });

  it('leaves following off when the owner turns it off during the enqueue', async () => {
    const { fake, requestId } = await setup(undefined, { manifest: range13 });
    publish(fake, 11, 3);
    wrapClient((base) => ({
      enqueueChapters: async (chapterIds, options) => {
        await setManifest(requestId, {
          followEnabled: false,
          followNextAt: null,
        });
        return base.enqueueChapters(chapterIds, options);
      },
    }));

    assert.deepStrictEqual(await follow(), ran({ added: 1, enqueued: 1 }));

    assert.deepStrictEqual(await followOf(requestId), {
      followEnabled: false,
      followStopReason: null,
      followNextAt: null,
    });
    assertSettled();
  });

  it('keeps a check the owner asked for during the enqueue due', async () => {
    const { fake, requestId } = await setup();
    publish(fake, 11, 3);
    wrapClient((base) => ({
      enqueueChapters: async (chapterIds, options) => {
        await setManifest(requestId, { followNextAt: null });
        return base.enqueueChapters(chapterIds, options);
      },
    }));

    assert.deepStrictEqual(await follow(), ran({ added: 1, enqueued: 1 }));

    assert.deepStrictEqual(await followOf(requestId), {
      followEnabled: true,
      followStopReason: null,
      followNextAt: null,
    });
  });
});

describe('runMangaFollow: pauses', () => {
  it('pauses following while the title has no active binding, and resumes once it has', async () => {
    const { fake, requestId, manifest, binding } = await setup();
    assert.ok(binding);
    await getRepository(MangaSourceBinding).update(binding.id, {
      state: MangaBindingState.ORPHANED,
    });

    const before = Date.now();
    assert.deepStrictEqual(await follow(), ran({ checked: 0, paused: 1 }));
    const after = Date.now();

    const paused = await followOf(requestId);
    assert.strictEqual(paused.followEnabled, true);
    assert.strictEqual(
      paused.followStopReason,
      MangaFollowStopReason.BINDING_INACTIVE
    );
    assertWait(paused.followNextAt, MANGA_FOLLOW_WAIT_MS.paused, before, after);
    assert.deepStrictEqual(fake.server.requests, []);

    await getRepository(MangaSourceBinding).update(binding.id, {
      state: MangaBindingState.ACTIVE,
    });
    await makeDue(requestId);
    assert.deepStrictEqual(await follow(), ran());
    assert.strictEqual((await manifestOf(requestId)).followStopReason, null);
    assertSettled(
      settlementLog(
        'Manga follow paused',
        requestId,
        manifest.id,
        MangaFollowStopReason.BINDING_INACTIVE
      )
    );
  });

  it('pauses following while the request waits for a binding', async () => {
    const { fake, requestId, manifest } = await setup();
    await setManifest(requestId, {
      bindingState: MangaRequestBindingState.AWAITING_BINDING,
    });

    assert.deepStrictEqual(await follow(), ran({ checked: 0, paused: 1 }));

    assert.strictEqual(
      (await manifestOf(requestId)).followStopReason,
      MangaFollowStopReason.BINDING_INACTIVE
    );
    assert.deepStrictEqual(fake.server.requests, []);
    assertSettled(
      settlementLog(
        'Manga follow paused',
        requestId,
        manifest.id,
        MangaFollowStopReason.BINDING_INACTIVE
      )
    );
  });

  it('pauses following while the instance is not configured', async () => {
    const { fake, requestId, manifest } = await setup();
    configure();

    assert.deepStrictEqual(await follow(), ran({ checked: 0, paused: 1 }));

    assert.strictEqual(
      (await manifestOf(requestId)).followStopReason,
      MangaFollowStopReason.INSTANCE_MISSING
    );
    assert.deepStrictEqual(fake.server.requests, []);
    assertSettled(
      settlementLog(
        'Manga follow paused',
        requestId,
        manifest.id,
        MangaFollowStopReason.INSTANCE_MISSING
      )
    );
  });

  it('pauses following when the title is bound to another manga, adding nothing from it', async () => {
    const { fake, requestId, manifest, binding } = await setup();
    const other = mangaWith(12, [1, 2, 3, 4]);
    fake.state.mangas.push(other);
    assert.ok(binding);
    await getRepository(MangaSourceBinding).update(binding.id, {
      state: MangaBindingState.REJECTED,
    });
    await seedDispatchBinding(other);
    publish(fake, 11, 3);

    assert.deepStrictEqual(await follow(), ran({ checked: 0, paused: 1 }));

    assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
    assert.strictEqual(
      (await manifestOf(requestId)).followStopReason,
      MangaFollowStopReason.BINDING_CHANGED
    );
    assert.deepStrictEqual(fake.server.requests, []);
    assertSettled(
      settlementLog(
        'Manga follow paused',
        requestId,
        manifest.id,
        MangaFollowStopReason.BINDING_CHANGED
      )
    );
  });
});

describe('runMangaFollow: instances', () => {
  it('stops on an instance whose server carries another marker', async () => {
    const { fake, requestId } = await setup();
    fake.state.globalMeta.set(INSTANCE_MARKER_KEY, randomUUID());
    publish(fake, 11, 3);

    assert.deepStrictEqual(
      await follow(),
      ran({ checked: 0, instancesFailed: 1 })
    );

    assert.deepStrictEqual(fake.operationNames(), ['InstanceMarker']);
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2]);
    assert.strictEqual((await manifestOf(requestId)).followNextAt, null);
    assert.deepStrictEqual(logged('Manga follow stopped on an instance'), [
      [
        'warn',
        { label, instanceId: 1, code: 'MANGA_FOLLOW_INSTANCE_MISMATCH' },
      ],
    ]);
  });

  it('stops on an instance it has no client for', async () => {
    const { fake, requestId } = await setup();
    clients.delete(1);

    assert.deepStrictEqual(
      await follow(),
      ran({ checked: 0, instancesFailed: 1 })
    );

    assert.deepStrictEqual(fake.server.requests, []);
    assert.strictEqual((await manifestOf(requestId)).followNextAt, null);
    assert.deepStrictEqual(logged('Manga follow stopped on an instance'), [
      ['warn', { label, code: 'NO_CLIENT', instanceId: 1 }],
    ]);
  });
});

describe('mangaFollowPoller', () => {
  it('does nothing while manga is disabled', async () => {
    const { fake, requestId } = await setup();
    settings.main.enabledMediaCategories = { ...categories, manga: false };

    await mangaFollowPoller.run();

    assert.deepStrictEqual(fake.server.requests, []);
    assert.deepStrictEqual(logs, []);
    assert.strictEqual((await manifestOf(requestId)).followNextAt, null);
  });

  it('follows the configured instances and logs the counts', async () => {
    const { fake, requestId } = await setup();
    publish(fake, 11, 3);
    const asked: number[] = [];
    mock.method(
      AnilistAPI.prototype,
      'getMangaDetails',
      async (anilistId: number) => {
        asked.push(anilistId);
        return { status: 'RELEASING' } as AnilistMangaDetails;
      }
    );

    await mangaFollowPoller.run();

    assert.deepStrictEqual(logged('Manga follow run finished'), [
      ['debug', { label, ...ran({ added: 1, enqueued: 1 }) }],
    ]);
    assert.deepStrictEqual(asked, [9001]);
    assert.deepStrictEqual(await numbersOf(requestId), [1, 2, 3]);
    assert.deepStrictEqual(fake.enqueuedIds(), [1103]);
    assert.deepStrictEqual(mangaFollowPoller.status(), { running: false });
  });

  it('runs once at a time and stops when cancelled', async () => {
    const { fake, requestId } = await setup();
    fake.fault('FetchMangaAndChapters', 'hang');
    let arrived!: () => void;
    const hanging = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    fake.observe((request) => {
      if (request.operationName === 'FetchMangaAndChapters') arrived();
    });

    const running = mangaFollowPoller.run();
    await hanging;
    assert.deepStrictEqual(mangaFollowPoller.status(), { running: true });
    await mangaFollowPoller.run();
    assert.strictEqual(fake.server.operations('InstanceMarker').length, 1);

    mangaFollowPoller.cancel();
    await running;

    assert.deepStrictEqual(logged('Manga follow run cancelled'), [
      ['info', { label }],
    ]);
    assert.deepStrictEqual(logged('Manga follow run finished'), []);
    assert.deepStrictEqual(mangaFollowPoller.status(), { running: false });
    assert.strictEqual((await manifestOf(requestId)).followNextAt, null);
  });
});

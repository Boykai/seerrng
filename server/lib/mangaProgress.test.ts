import SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import {
  MANGA_CHAPTER_MISSING_GRACE_MS,
  MANGA_PROGRESS_RECHECK_MS,
  MangaAttentionCode,
  MangaChapterFileState,
  MangaChapterQueueState,
  MangaRequestBindingState,
} from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaLibraryOwnership from '@server/entity/MangaLibraryOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import * as mediaRequestModule from '@server/entity/MediaRequest';
import { MediaRequest } from '@server/entity/MediaRequest';
import downloadTracker from '@server/lib/downloadtracker';
import {
  completeMangaRequest,
  isInsideMangaProgressLock,
  mangaProgressPoller,
  pollMangaProgress,
  type MangaProgressClient,
  type MangaProgressCounts,
  type MangaProgressOptions,
} from '@server/lib/mangaProgress';
import * as mediaMutation from '@server/lib/mediaMutation';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import * as instanceAdmission from '@server/lib/suwayomi/instanceAdmission';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import {
  FAKE_TITLE_PREFIX,
  FAKE_URL_PREFIX,
  dispatchInstanceFor,
  fakeChapterUrl,
  fakeDispatchChapters,
  fakeDispatchManga,
  fakeMangaUrl,
  seedDispatchBinding,
  type FakeDispatchChapter,
  type FakeDispatchManga,
} from '@server/test/fakeSuwayomiDispatch';
import {
  assertProgressTraffic,
  emptyArchive,
  noLengthArchive,
  seedProgressRequest,
  startFakeProgressSuwayomi,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

setupTestDb();

const { QUEUED, DOWNLOADING, DOWNLOADED, NOT_QUEUED, UNMAPPED } =
  MangaChapterQueueState;
const { APPROVED, COMPLETED, DECLINED } = MediaRequestStatus;
const HOUR_MS = 60 * 60 * 1_000;
/** Past the recheck delay, so a check made before it is due again. */
const RECHECK_PASSED_MS = MANGA_PROGRESS_RECHECK_MS + 60_000;
const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const fakes: FakeProgressSuwayomi[] = [];
/** The poll's client for each instance, by instance ID. */
const clients = new Map<number, MangaProgressClient>();

type Level = 'error' | 'warn' | 'info' | 'debug';
type LogEntry = [Level, string, Record<string, unknown>];
let logs: LogEntry[] = [];
let intents: { type: Notification; intent: unknown }[] = [];

type Counts = Partial<
  Record<'verified' | 'queued' | 'downloading' | 'errored' | 'missing', number>
>;

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

/** A client of `fake` with short timeouts and, optionally, a lower size cap. */
const clientOf = (fake: FakeProgressSuwayomi, chapterArchiveBytes?: number) =>
  new SuwayomiAPI({
    url: fake.server.url,
    auth: { mode: 'NONE' },
    timeouts: {
      query: 2_000,
      mutation: 2_000,
      queue: 2_000,
      source: 2_000,
      bytes: 2_000,
    },
    readback: { attempts: 2, delayMs: 0 },
    warnInsecureAuthMode: false,
    ...(chapterArchiveBytes !== undefined && {
      limits: { chapterArchiveBytes },
    }),
  });

/** `base`, with some of its calls replaced. */
const clientWith = (
  base: MangaProgressClient,
  overrides: Partial<MangaProgressClient>
): MangaProgressClient => ({
  getAvailability: (ids, options) => base.getAvailability(ids, options),
  getQueue: (options) => base.getQueue(options),
  findMangaByNaturalKey: (sourceId, url, options) =>
    base.findMangaByNaturalKey(sourceId, url, options),
  getChaptersToDownload: (mangaId, options) =>
    base.getChaptersToDownload(mangaId, options),
  getDownloadedChapters: (mangaId, options) =>
    base.getDownloadedChapters(mangaId, options),
  headChapterArchive: (chapterId, options) =>
    base.headChapterArchive(chapterId, options),
  ...overrides,
});

/** A fake serving `mangas`, polled as instance `instanceId`. */
const start = async (mangas: FakeDispatchManga[], instanceId = 1) => {
  const fake = await startFakeProgressSuwayomi(mangas);
  fakes.push(fake);
  clients.set(instanceId, clientOf(fake));
  return fake;
};

const poll = (options: MangaProgressOptions = {}) =>
  pollMangaProgress({ clientFor: (id) => clients.get(id), ...options });

const libraryManga = (id: number, overrides: Partial<FakeDispatchManga> = {}) =>
  fakeDispatchManga(id, { inLibrary: true, ...overrides });

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

/** A request for AniList `anilistId` that dispatch enqueued on `manga`. */
const seedEnqueued = async (
  fake: FakeProgressSuwayomi,
  manga: FakeDispatchManga,
  options: Parameters<typeof seedProgressRequest>[1] = {}
) => {
  const seeded = await seedProgressRequest(manga, {
    mediaStatus: MediaStatus.PROCESSING,
    ...options,
  });
  queueFrozen(fake, manga, seeded.rows);
  return { ...seeded, requestId: seeded.request.id };
};

/**
 * Manga `manga` (11 by default) in instance 1's library, AniList 9001 bound
 * to it, and an approved request for 9001 whose dispatch froze `numbers`
 * and queued every frozen chapter not downloaded yet.
 */
const setup = async (
  manga: FakeDispatchManga = libraryManga(11),
  {
    binding = {},
    ...options
  }: Parameters<typeof seedProgressRequest>[1] & {
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
    ...(await seedEnqueued(fake, manga, options)),
  };
};

/** Another title on a running fake: `manga` bound to `anilistId`, requested. */
const seedTitle = async (
  fake: FakeProgressSuwayomi,
  manga: FakeDispatchManga,
  anilistId: number,
  options: Parameters<typeof seedProgressRequest>[1] = {}
) => {
  await seedDispatchBinding(manga, {
    anilistId,
    instanceId: options.instanceId ?? 1,
  });
  return seedEnqueued(fake, manga, { anilistId, ...options });
};

/** A library manga with chapters `numbers`, `downloaded` of them on disk. */
const mangaWith = (
  id: number,
  numbers: readonly number[],
  downloaded: readonly number[] = []
) =>
  libraryManga(id, { chapters: fakeDispatchChapters(id, numbers, downloaded) });

/** A run's counts: one manifest and nothing else unless `partial` says so. */
const ran = (
  partial: Partial<MangaProgressCounts> = {}
): MangaProgressCounts => ({
  manifests: 1,
  chapterReads: 0,
  heads: 0,
  completed: 0,
  instancesFailed: 0,
  ...partial,
});

/** Every operation a read of a manga's chapter lists sends. */
const READ = [
  'Availability',
  'ByNaturalKey',
  'ChaptersToDownload',
  'DownloadedChapters',
];

const manifestOf = (requestId: number) =>
  getRepository(MangaRequestManifest).findOneByOrFail({ requestId });

const rowsOf = async (requestId: number) => {
  const { id } = await manifestOf(requestId);
  return getRepository(MangaRequestChapter).find({
    where: { manifestId: id },
    order: { id: 'ASC' },
  });
};

/** The manifest's chapter counts, zeros left out. */
const countsOf = async (requestId: number): Promise<Counts> => {
  const manifest = await manifestOf(requestId);
  const counts: Counts = {
    verified: manifest.chaptersVerified,
    queued: manifest.chaptersQueued,
    downloading: manifest.chaptersDownloading,
    errored: manifest.chaptersErrored,
    missing: manifest.chaptersMissing,
  };
  for (const key of Object.keys(counts) as (keyof Counts)[]) {
    if (counts[key] === 0) delete counts[key];
  }
  return counts;
};

const attentionOf = async (requestId: number) =>
  (await manifestOf(requestId)).attentionCode;

const statusOf = async (requestId: number) =>
  (await getRepository(MediaRequest).findOneByOrFail({ id: requestId })).status;

const mediaStatusOf = async (id: number) =>
  (await getRepository(Media).findOneByOrFail({ id })).status;

const queueStatesOf = async (requestId: number) =>
  (await rowsOf(requestId)).map(({ lastQueueState }) => lastQueueState);

const fileStatesOf = async (requestId: number) =>
  (await rowsOf(requestId)).map(({ fileState }) => fileState);

const verifiedOf = async (requestId: number) =>
  (await rowsOf(requestId)).map(({ deliverableAt }) => deliverableAt !== null);

/** Moves a stored time of every row back, as if `ms` had passed. */
const backdate = async (
  requestId: number,
  field: 'headCheckedAt' | 'missingSince',
  ms: number
) => {
  for (const row of await rowsOf(requestId)) {
    const value = row[field];
    if (value === null) continue;
    await getRepository(MangaRequestChapter).update(row.id, {
      [field]: new Date(value.getTime() - ms),
    });
  }
};

const setRow = (
  row: MangaRequestChapter,
  values: Partial<MangaRequestChapter>
) => getRepository(MangaRequestChapter).update(row.id, values);

/** The MEDIA_AVAILABLE intents queued so far. */
const announced = () =>
  intents
    .filter(({ type }) => type === Notification.MEDIA_AVAILABLE)
    .map(({ intent }) => intent);

/** Title, status and percent of each tracker item of an AniList title. */
const trackerOf = (anilistId = 9001, instanceId = 1) =>
  downloadTracker
    .getMangaProgress(instanceId, anilistId)
    .map(({ title, status, percent }) => [title, status, percent]);

/** Operation names `fake` received after the first `from`. */
const operationsSince = (fake: FakeProgressSuwayomi, from: number) =>
  fake.operationNames().slice(from);

/** The manga URLs ByNaturalKey asked `fake` for, in order. */
const resolvedUrls = (fake: FakeProgressSuwayomi) =>
  fake.server.operations('ByNaturalKey').map(({ variables }) => variables.url);

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

/** Log lines name codes, counts and IDs: never a URL or a title. */
const assertPrivateLogs = () => {
  const text = inspect(logs, {
    depth: 12,
    maxArrayLength: null,
    maxStringLength: null,
  });
  for (const secret of [FAKE_URL_PREFIX, FAKE_TITLE_PREFIX, 'com.example']) {
    assert.ok(!text.includes(secret), `A log line carried ${secret}`);
  }
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
      assertProgressTraffic(fake.server);
    }
    assertPrivateLogs();
  } finally {
    mock.restoreAll();
    settings.main.enabledMediaCategories = categories;
    configure();
    downloadTracker.pruneMangaProgress(new Map());
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

describe('pollMangaProgress: delivery', () => {
  it('completes a request only once every frozen chapter passes its HEAD', async () => {
    const { fake, manga, requestId, media } = await setup();
    fake.queueItems.set(1101, { state: 'DOWNLOADING', progress: 0.5 });

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(fake.operationNames(), READ);
    assert.deepStrictEqual(await countsOf(requestId), {
      downloading: 1,
      queued: 2,
    });
    assert.deepStrictEqual(await queueStatesOf(requestId), [
      DOWNLOADING,
      QUEUED,
      QUEUED,
    ]);
    assert.deepStrictEqual(trackerOf(), [
      ['Chapter 1', 'downloading', 50],
      ['Chapter 2', 'queued', 0],
      ['Chapter 3', 'queued', 0],
    ]);
    assert.strictEqual(await attentionOf(requestId), null);
    assert.strictEqual(await mediaStatusOf(media.id), MediaStatus.PROCESSING);

    downloadChapter(fake, manga.id, 1);
    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1, heads: 1 }));
    assert.deepStrictEqual(await verifiedOf(requestId), [true, false, false]);
    assert.deepStrictEqual(await countsOf(requestId), {
      verified: 1,
      queued: 2,
    });
    assert.strictEqual(await statusOf(requestId), APPROVED);
    assert.strictEqual(
      await mediaStatusOf(media.id),
      MediaStatus.PARTIALLY_AVAILABLE
    );

    downloadChapter(fake, manga.id, 2, 3);
    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 2, completed: 1 })
    );
    assert.deepStrictEqual(fake.headIds(), [1101, 1102, 1103]);
    assert.deepStrictEqual(await countsOf(requestId), { verified: 3 });
    assert.strictEqual(await statusOf(requestId), COMPLETED);
    assert.strictEqual(await mediaStatusOf(media.id), MediaStatus.AVAILABLE);
    assert.deepStrictEqual(trackerOf(), []);
    await waitForBackgroundTasks();
    assert.deepStrictEqual(announced(), [{ kind: 'media-request', requestId }]);

    // A completed request leaves the poll.
    assert.deepStrictEqual(await poll(), ran({ manifests: 0 }));
  });

  it('never verifies an empty file, and flags it when it repeats', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1], [1]));
    fake.archives.set(1101, emptyArchive);

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1, heads: 1 }));
    assert.deepStrictEqual(await fileStatesOf(requestId), [
      MangaChapterFileState.EMPTY,
    ]);
    assert.deepStrictEqual(await countsOf(requestId), { downloading: 1 });
    assert.strictEqual(await attentionOf(requestId), null);

    // The next poll checks an empty file again at once.
    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1, heads: 1 }));
    assert.deepStrictEqual(await fileStatesOf(requestId), [
      MangaChapterFileState.MISSING,
    ]);
    assert.deepStrictEqual(await countsOf(requestId), { missing: 1 });
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_FILE_MISSING
    );
    const { attentionAt } = await manifestOf(requestId);
    assert.ok(attentionAt);

    // Then only after the recheck delay; the code and its time hold.
    const before = fake.operationNames().length;
    assert.deepStrictEqual(await poll(), ran());
    assert.deepStrictEqual(operationsSince(fake, before), ['Availability']);
    assert.deepStrictEqual(
      (await manifestOf(requestId)).attentionAt,
      attentionAt
    );
    assert.deepStrictEqual(fake.headIds(), [1101, 1101]);

    fake.archives.delete(1101);
    await backdate(requestId, 'headCheckedAt', RECHECK_PASSED_MS);
    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 1, completed: 1 })
    );
    assert.strictEqual(await attentionOf(requestId), null);
    assert.deepStrictEqual(await fileStatesOf(requestId), [null]);
    assert.strictEqual(await statusOf(requestId), COMPLETED);
  });

  it('counts a file over the size cap as delivered', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1], [1]));
    clients.set(1, clientOf(fake, 1_000));

    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 1, completed: 1 })
    );
    assert.deepStrictEqual(await verifiedOf(requestId), [true]);
    assert.strictEqual(await statusOf(requestId), COMPLETED);
  });

  it('flags a file of unknown length and clears it once the size shows', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1], [1]));
    fake.archives.set(1101, noLengthArchive);

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1, heads: 1 }));
    assert.deepStrictEqual(await fileStatesOf(requestId), [
      MangaChapterFileState.NO_LENGTH,
    ]);
    assert.deepStrictEqual(await countsOf(requestId), { downloading: 1 });
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_LENGTH_UNKNOWN
    );

    // Not checked again before the recheck delay.
    assert.deepStrictEqual(await poll(), ran());
    assert.deepStrictEqual(fake.headIds(), [1101]);

    fake.archives.delete(1101);
    await backdate(requestId, 'headCheckedAt', RECHECK_PASSED_MS);
    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 1, completed: 1 })
    );
    assert.strictEqual(await attentionOf(requestId), null);
    assert.strictEqual(await statusOf(requestId), COMPLETED);
  });

  it('ranks an unknown length below a missing file and above a missing chapter', async () => {
    const manga = mangaWith(11, [1, 2, 3], [1]);
    const { fake, requestId } = await setup(manga);
    fake.archives.set(1101, noLengthArchive);
    manga.chapters = manga.chapters.filter(({ id }) => id !== 1102);
    fake.state.queue = fake.state.queue.filter((id) => id !== 1102);

    await poll();
    assert.deepStrictEqual(await queueStatesOf(requestId), [
      DOWNLOADED,
      UNMAPPED,
      QUEUED,
    ]);
    assert.deepStrictEqual(await countsOf(requestId), {
      downloading: 1,
      missing: 1,
      queued: 1,
    });
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_LENGTH_UNKNOWN
    );

    // Past the grace, the missing chapter still ranks lower.
    await backdate(
      requestId,
      'missingSince',
      MANGA_CHAPTER_MISSING_GRACE_MS + HOUR_MS
    );
    await poll();
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_LENGTH_UNKNOWN
    );

    fake.archives.set(1103, emptyArchive);
    downloadChapter(fake, manga.id, 3);
    await poll();
    assert.deepStrictEqual(await fileStatesOf(requestId), [
      MangaChapterFileState.NO_LENGTH,
      null,
      MangaChapterFileState.EMPTY,
    ]);
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_LENGTH_UNKNOWN
    );

    await poll();
    assert.deepStrictEqual(await fileStatesOf(requestId), [
      MangaChapterFileState.NO_LENGTH,
      null,
      MangaChapterFileState.MISSING,
    ]);
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_FILE_MISSING
    );

    fake.archives.clear();
    await backdate(requestId, 'headCheckedAt', RECHECK_PASSED_MS);
    await poll();
    assert.deepStrictEqual(await verifiedOf(requestId), [true, false, true]);
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_MISSING
    );
    assert.strictEqual(await statusOf(requestId), APPROVED);
  });

  it('keeps a verified chapter until a later HEAD finds its file gone', async () => {
    const manga = mangaWith(11, [1, 2], [1]);
    const { fake, requestId } = await setup(manga);

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1, heads: 1 }));
    assert.deepStrictEqual(await verifiedOf(requestId), [true, false]);

    manga.chapters[0].isDownloaded = false;
    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(await verifiedOf(requestId), [true, false]);
    assert.deepStrictEqual(await countsOf(requestId), {
      verified: 1,
      queued: 1,
    });

    await backdate(requestId, 'headCheckedAt', RECHECK_PASSED_MS);
    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1, heads: 1 }));
    assert.deepStrictEqual(await verifiedOf(requestId), [false, false]);
    assert.deepStrictEqual(await queueStatesOf(requestId), [
      NOT_QUEUED,
      QUEUED,
    ]);
    assert.deepStrictEqual(await countsOf(requestId), {
      missing: 1,
      queued: 1,
    });
    assert.strictEqual(await attentionOf(requestId), null);

    // Still not queued on the next poll.
    assert.deepStrictEqual(await poll(), ran());
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_NOT_QUEUED
    );
    assert.deepStrictEqual(fake.headIds(), [1101, 1101]);
  });
});

describe('pollMangaProgress: budget and cursor', () => {
  it('spreads file checks across polls within the HEAD budget', async () => {
    const { fake, requestId } = await setup(
      mangaWith(11, [1, 2, 3], [1, 2, 3])
    );
    const limits = { heads: 1 };

    assert.deepStrictEqual(
      await poll({ limits }),
      ran({ chapterReads: 1, heads: 1 })
    );
    assert.deepStrictEqual(await verifiedOf(requestId), [true, false, false]);
    // A cut run leaves the manifest at the front of the cursor.
    assert.strictEqual((await manifestOf(requestId)).progressAt, null);

    assert.deepStrictEqual(
      await poll({ limits }),
      ran({ chapterReads: 1, heads: 1 })
    );
    assert.deepStrictEqual(await verifiedOf(requestId), [true, true, false]);
    assert.strictEqual((await manifestOf(requestId)).progressAt, null);

    assert.deepStrictEqual(
      await poll({ limits }),
      ran({ chapterReads: 1, heads: 1, completed: 1 })
    );
    assert.deepStrictEqual(fake.headIds(), [1101, 1102, 1103]);
    assert.ok((await manifestOf(requestId)).progressAt);
    assert.strictEqual(await statusOf(requestId), COMPLETED);
  });

  it('defers a manga with checks due once the budget is spent', async () => {
    const { fake } = await setup(mangaWith(11, [1], [1]));
    const other = mangaWith(12, [1], [1]);
    fake.state.mangas.push(other);
    fake.serveArchives();
    const second = await seedTitle(fake, other, 9002);
    await setRow(second.rows[0], { lastQueueState: DOWNLOADED });

    assert.deepStrictEqual(
      await poll({ limits: { heads: 1 } }),
      ran({ manifests: 2, chapterReads: 1, heads: 1, completed: 1 })
    );
    assert.deepStrictEqual(resolvedUrls(fake), [fakeMangaUrl(11)]);
    assert.strictEqual((await manifestOf(second.requestId)).progressAt, null);

    assert.deepStrictEqual(
      await poll({ limits: { heads: 1 } }),
      ran({ chapterReads: 1, heads: 1, completed: 1 })
    );
    assert.strictEqual(await statusOf(second.requestId), COMPLETED);
  });

  it('takes the least recently polled manifests first', async () => {
    const { fake } = await setup();
    const other = libraryManga(12);
    fake.state.mangas.push(other);
    await seedTitle(fake, other, 9002);
    const limits = { manifests: 1 };

    const runs = [];
    for (let run = 0; run < 3; run += 1) runs.push(await poll({ limits }));
    // The third finds title 11 unchanged and skips its read.
    assert.deepStrictEqual(runs, [
      ran({ chapterReads: 1 }),
      ran({ chapterReads: 1 }),
      ran(),
    ]);
    assert.deepStrictEqual(
      fake.server
        .operations('Availability')
        .map(({ variables }) => variables.ids),
      [[11], [12], [11]]
    );
  });

  it('reads a title once for every request on it', async () => {
    const { fake, manga, media, requestId } = await setup();
    const second = await seedEnqueued(fake, manga, { media });

    assert.deepStrictEqual(
      await poll({ limits: { manifests: 1 } }),
      ran({ chapterReads: 1 })
    );
    assert.ok((await manifestOf(requestId)).progressAt);
    assert.ok((await manifestOf(second.requestId)).progressAt);
    assert.deepStrictEqual(await countsOf(second.requestId), { queued: 3 });
    assert.strictEqual(trackerOf().length, 3);
  });
});

describe('pollMangaProgress: skipping reads', () => {
  it('reads the chapter lists again only when the manga or its queue changed', async () => {
    const { fake } = await setup(mangaWith(11, [1, 2]));
    fake.queueItems.set(1101, { state: 'DOWNLOADING', progress: 0.25 });
    const tracked = [
      ['Chapter 1', 'downloading', 25],
      ['Chapter 2', 'queued', 0],
    ];

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(trackerOf(), tracked);

    let before = fake.operationNames().length;
    assert.deepStrictEqual(await poll(), ran());
    assert.deepStrictEqual(operationsSince(fake, before), ['Availability']);
    assert.deepStrictEqual(trackerOf(), tracked);

    fake.fetchedAt.set(11, '1700000500');
    before = fake.operationNames().length;
    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(operationsSince(fake, before), READ);

    fake.queueItems.set(1101, { state: 'DOWNLOADING', progress: 0.75 });
    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(trackerOf()[0], ['Chapter 1', 'downloading', 75]);
  });
});

describe('pollMangaProgress: stale manga IDs', () => {
  it('resolves the manga again when the cached ID finds nothing', async () => {
    const { fake, requestId } = await setup(undefined, {
      manifest: { suwayomiMangaId: 99 },
    });

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.strictEqual((await manifestOf(requestId)).suwayomiMangaId, 11);
    assert.deepStrictEqual(await poll(), ran());
    assert.deepStrictEqual(
      fake.server
        .operations('Availability')
        .map(({ variables }) => variables.ids),
      [[99], [11]]
    );
  });

  it('follows a manga Suwayomi gave a new ID', async () => {
    const { fake, manga, requestId, binding } = await setup(mangaWith(11, [1]));
    manga.id = 13;
    manga.chapters = [
      {
        id: 1301,
        url: fakeChapterUrl(11, 1),
        chapterNumber: 1,
        isDownloaded: true,
      },
    ];
    fake.state.queue = [];
    fake.serveArchives();

    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 1, completed: 1 })
    );
    assert.deepStrictEqual(fake.headIds(), [1301]);
    assert.strictEqual((await manifestOf(requestId)).suwayomiMangaId, 13);
    assert.strictEqual(
      (
        await getRepository(MangaSourceBinding).findOneByOrFail({
          id: binding!.id,
        })
      ).suwayomiMangaId,
      13
    );
  });

  it('trusts nothing from a read whose chapter ID went stale', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1], [1]));
    fake.archives.set(1101, { status: 404 });

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1, heads: 1 }));
    const manifest = await manifestOf(requestId);
    assert.strictEqual(manifest.progressSignature, null);
    assert.ok(manifest.progressAt);
    assert.deepStrictEqual(await verifiedOf(requestId), [false]);
    assert.strictEqual(await statusOf(requestId), APPROVED);

    fake.archives.delete(1101);
    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 1, completed: 1 })
    );
    assert.deepStrictEqual(fake.headIds(), [1101, 1101]);
  });
});

describe('pollMangaProgress: remapping', () => {
  it('moves a row and its ownership to the chapter that replaced its URL', async () => {
    const manga = mangaWith(11, [1]);
    const { fake, requestId } = await setup(manga, { owned: true });
    const moved = `${fakeChapterUrl(11, 1)}-moved`;
    manga.chapters = [
      { id: 1111, url: moved, chapterNumber: 1, isDownloaded: false },
    ];
    fake.state.queue = [];
    fake.serveArchives();

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(fake.operationNames(), [...READ, 'Queue']);
    const [row] = await rowsOf(requestId);
    assert.strictEqual(row.url, moved);
    assert.strictEqual(row.urlHash, hashMangaSourceUrl(moved));
    assert.strictEqual(row.lastQueueState, NOT_QUEUED);
    assert.deepStrictEqual(await countsOf(requestId), { missing: 1 });
    // A remapped chapter nobody queued needs a dispatch now.
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_NOT_QUEUED
    );
    const [owned] = await getRepository(MangaChapterOwnership).find();
    assert.strictEqual(owned.chapterUrlHash, hashMangaSourceUrl(moved));
    assert.strictEqual(owned.chapterUrl, moved);
  });

  it('leaves a row unmapped when no single chapter can take it', async () => {
    const manga = mangaWith(11, [1, 2, 3, 4]);
    const { fake, requestId } = await setup(manga);
    manga.chapters = [
      // Chapter 1's only candidate is a URL another row already holds.
      {
        id: 1102,
        url: fakeChapterUrl(11, 2),
        chapterNumber: 1,
        isDownloaded: false,
      },
      // Chapter 3 has two candidates; chapter 4 has none.
      {
        id: 1131,
        url: `${fakeChapterUrl(11, 3)}-a`,
        chapterNumber: 3,
        isDownloaded: false,
      },
      {
        id: 1132,
        url: `${fakeChapterUrl(11, 3)}-b`,
        chapterNumber: 3,
        isDownloaded: false,
      },
    ];
    fake.state.queue = [1102];

    await poll();
    assert.deepStrictEqual(await queueStatesOf(requestId), [
      UNMAPPED,
      QUEUED,
      UNMAPPED,
      UNMAPPED,
    ]);
    assert.deepStrictEqual(await countsOf(requestId), {
      missing: 3,
      queued: 1,
    });
    assert.strictEqual(await attentionOf(requestId), null);

    await backdate(
      requestId,
      'missingSince',
      MANGA_CHAPTER_MISSING_GRACE_MS + HOUR_MS
    );
    const before = fake.operationNames().length;
    await poll();
    assert.deepStrictEqual(operationsSince(fake, before), ['Availability']);
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_MISSING
    );

    manga.chapters = fakeDispatchChapters(11, [1, 2, 3, 4]);
    fake.state.queue = [1101, 1102, 1103, 1104];
    await poll();
    assert.deepStrictEqual(await queueStatesOf(requestId), [
      QUEUED,
      QUEUED,
      QUEUED,
      QUEUED,
    ]);
    assert.ok(
      (await rowsOf(requestId)).every((row) => row.missingSince === null)
    );
    assert.strictEqual(await attentionOf(requestId), null);
  });

  it('remaps no row when two rows claim the same chapter', async () => {
    const manga = libraryManga(11, {
      chapters: [
        chapterOf({
          id: 1101,
          chapterNumber: 1,
          url: `${fakeChapterUrl(11, 1)}-a`,
          scanlator: 'Alpha',
        }),
        chapterOf({
          id: 1102,
          chapterNumber: 1,
          url: `${fakeChapterUrl(11, 1)}-b`,
          scanlator: 'ALPHA',
        }),
      ],
    });
    const { fake, requestId } = await setup(manga);
    manga.chapters = [
      chapterOf({
        id: 1103,
        chapterNumber: 1,
        url: `${fakeChapterUrl(11, 1)}-c`,
        scanlator: ' alpha ',
      }),
    ];
    fake.state.queue = [1103];
    fake.serveArchives();

    await poll();
    assert.deepStrictEqual(await queueStatesOf(requestId), [
      UNMAPPED,
      UNMAPPED,
    ]);
    assert.deepStrictEqual(
      (await rowsOf(requestId)).map(({ url }) => url),
      [`${fakeChapterUrl(11, 1)}-a`, `${fakeChapterUrl(11, 1)}-b`]
    );
  });
});

describe('pollMangaProgress: attention', () => {
  it('flags a chapter not queued on two polls in a row', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1]));
    fake.state.queue = [];

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(fake.operationNames(), [...READ, 'Queue']);
    assert.deepStrictEqual(await queueStatesOf(requestId), [NOT_QUEUED]);
    assert.deepStrictEqual(await countsOf(requestId), { missing: 1 });
    assert.strictEqual(await attentionOf(requestId), null);

    assert.deepStrictEqual(await poll(), ran());
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_NOT_QUEUED
    );
    const [{ id: instanceId }] = settings.suwayomi;
    const meta = { label: 'Manga Progress', requestId, instanceId };
    assert.deepStrictEqual(logged('A manga request needs attention'), [
      ['warn', { ...meta, code: MangaAttentionCode.CHAPTER_NOT_QUEUED }],
    ]);

    fake.state.queue = [1101];
    await poll();
    assert.deepStrictEqual(await queueStatesOf(requestId), [QUEUED]);
    assert.strictEqual(await attentionOf(requestId), null);
    assert.deepStrictEqual(
      logged('A manga request no longer needs attention'),
      [['info', { ...meta, code: MangaAttentionCode.CHAPTER_NOT_QUEUED }]]
    );
    assert.strictEqual(logged('A manga request needs attention').length, 1);
  });

  it('reads the queue again before calling a chapter not queued', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1]));
    fake.state.queue = [];
    fake.observe((request) => {
      if (
        request.operationName === 'DownloadedChapters' &&
        fake.state.queue.length === 0
      ) {
        fake.state.queue.push(1101);
      }
    });

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(fake.operationNames(), [...READ, 'Queue']);
    assert.deepStrictEqual(await queueStatesOf(requestId), [QUEUED]);
    assert.deepStrictEqual(await countsOf(requestId), { queued: 1 });
  });

  it('flags a failed download until Suwayomi retries it', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1]));
    fake.queueItems.set(1101, { state: 'ERROR', tries: 3 });

    await poll();
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.CHAPTER_ERROR
    );
    assert.deepStrictEqual(await countsOf(requestId), { errored: 1 });
    assert.deepStrictEqual(trackerOf(), [['Chapter 1', 'failed', 0]]);

    fake.queueItems.delete(1101);
    await poll();
    assert.deepStrictEqual(await queueStatesOf(requestId), [QUEUED]);
    assert.strictEqual(await attentionOf(requestId), null);
  });

  it('flags a manga that left the library', async () => {
    const { manga, requestId } = await setup();
    manga.inLibrary = false;

    await poll();
    assert.strictEqual(
      await attentionOf(requestId),
      MangaAttentionCode.NOT_IN_LIBRARY
    );

    manga.inLibrary = true;
    await poll();
    assert.strictEqual(await attentionOf(requestId), null);
  });
});

describe('pollMangaProgress: bindings', () => {
  const { BINDING_ORPHANED } = MangaAttentionCode;

  it('keeps the rows of a manga Suwayomi no longer has', async () => {
    const { fake, requestId } = await setup();
    await poll();
    assert.strictEqual(trackerOf().length, 3);
    fake.state.mangas.splice(0);

    const before = fake.operationNames().length;
    assert.deepStrictEqual(await poll(), ran());
    assert.deepStrictEqual(operationsSince(fake, before), [
      'Availability',
      'ByNaturalKey',
    ]);
    const manifest = await manifestOf(requestId);
    assert.strictEqual(manifest.attentionCode, BINDING_ORPHANED);
    assert.strictEqual(manifest.progressSignature, null);
    assert.deepStrictEqual(await queueStatesOf(requestId), [
      QUEUED,
      QUEUED,
      QUEUED,
    ]);
    assert.deepStrictEqual(trackerOf(), []);
  });

  it('flags a manga with neither a binding nor a library entry', async () => {
    const { fake, requestId } = await setup(undefined, { binding: null });

    assert.deepStrictEqual(await poll(), ran());
    assert.deepStrictEqual(fake.operationNames(), ['Availability']);
    assert.strictEqual(await attentionOf(requestId), BINDING_ORPHANED);
  });

  it('resolves an unbound manga through its library entry', async () => {
    const { fake, manga, requestId } = await setup(undefined, {
      binding: null,
    });
    await getRepository(MangaLibraryOwnership).save(
      new MangaLibraryOwnership({
        instanceId: 1,
        sourceId: manga.sourceId,
        urlHash: hashMangaSourceUrl(manga.url),
        url: manga.url,
        addedBySeerrng: true,
      })
    );

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(resolvedUrls(fake), [fakeMangaUrl(11)]);
    assert.deepStrictEqual(await countsOf(requestId), { queued: 3 });
    assert.strictEqual(await attentionOf(requestId), BINDING_ORPHANED);
  });

  for (const [name, binding] of [
    ['another title', { anilistId: 9002 }],
    ['an orphaned binding', { state: MangaBindingState.ORPHANED }],
  ] as const) {
    it(`flags a manga bound to ${name}`, async () => {
      const { requestId } = await setup(undefined, { binding });

      assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
      assert.strictEqual(await attentionOf(requestId), BINDING_ORPHANED);
    });
  }

  it('clears the flag without a read once a rejected binding is active again', async () => {
    const { fake, requestId, binding } = await setup(undefined, {
      binding: { state: MangaBindingState.REJECTED },
    });

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.strictEqual(await attentionOf(requestId), BINDING_ORPHANED);

    await getRepository(MangaSourceBinding).update(binding!.id, {
      state: MangaBindingState.ACTIVE,
    });
    const before = fake.operationNames().length;
    assert.deepStrictEqual(await poll(), ran());
    assert.deepStrictEqual(operationsSince(fake, before), ['Availability']);
    assert.strictEqual(await attentionOf(requestId), null);
  });
});

describe('pollMangaProgress: instance removal', () => {
  it('flags the manifests of a removed instance without calling it', async () => {
    const { fake, requestId } = await setup();
    await poll();
    assert.strictEqual(trackerOf().length, 3);
    const [instance] = settings.suwayomi;

    configure();
    const requests = fake.server.requests.length;
    assert.deepStrictEqual(await poll(), ran());
    assert.strictEqual(fake.server.requests.length, requests);
    const flagged = await manifestOf(requestId);
    assert.strictEqual(
      flagged.attentionCode,
      MangaAttentionCode.INSTANCE_REMOVED
    );
    assert.ok(flagged.attentionAt);
    assert.ok(flagged.progressAt);
    assert.deepStrictEqual(trackerOf(), []);
    const removed = {
      label: 'Manga Progress',
      code: MangaAttentionCode.INSTANCE_REMOVED,
      instanceId: instance.id,
    };
    assert.deepStrictEqual(logged('Manga requests need attention'), [
      ['warn', { ...removed, count: 1 }],
    ]);

    assert.deepStrictEqual(await poll(), ran());
    assert.deepStrictEqual(
      (await manifestOf(requestId)).attentionAt,
      flagged.attentionAt
    );
    assert.strictEqual(logged('Manga requests need attention').length, 1);

    configure(instance);
    const before = fake.operationNames().length;
    assert.deepStrictEqual(await poll(), ran());
    assert.deepStrictEqual(operationsSince(fake, before), ['Availability']);
    assert.strictEqual(await attentionOf(requestId), null);
    assert.strictEqual(trackerOf().length, 3);
    assert.deepStrictEqual(
      logged('A manga request no longer needs attention'),
      [['info', { ...removed, requestId }]]
    );
  });
});

describe('pollMangaProgress: failures', () => {
  const unreachable = (operation: string) => () =>
    Promise.reject(new SuwayomiError('UNREACHABLE', operation));

  it('stops an instance it cannot reach and moves its manifests back', async () => {
    const { fake, requestId } = await setup();
    clients.set(
      1,
      clientWith(clientOf(fake), {
        getAvailability: unreachable('Availability'),
      })
    );

    assert.deepStrictEqual(await poll(), ran({ instancesFailed: 1 }));
    assert.deepStrictEqual(logged('Manga progress stopped on an instance'), [
      [
        'warn',
        {
          label: 'Manga Progress',
          instanceId: 1,
          suwayomiCode: 'UNREACHABLE',
          operation: 'Availability',
        },
      ],
    ]);
    assert.ok((await manifestOf(requestId)).progressAt);
    assert.deepStrictEqual(fake.operationNames(), []);
  });

  it('stops at the first failure every later call would hit too', async () => {
    const { fake, requestId } = await setup();
    const other = libraryManga(12);
    fake.state.mangas.push(other);
    const second = await seedTitle(fake, other, 9002);
    let calls = 0;
    clients.set(
      1,
      clientWith(clientOf(fake), {
        findMangaByNaturalKey: () => {
          calls += 1;
          return Promise.reject(new SuwayomiError('TIMEOUT', 'ByNaturalKey'));
        },
      })
    );

    assert.deepStrictEqual(
      await poll(),
      ran({ manifests: 2, instancesFailed: 1 })
    );
    assert.strictEqual(calls, 1);
    assert.ok((await manifestOf(requestId)).progressAt);
    assert.ok((await manifestOf(second.requestId)).progressAt);
  });

  it('keeps the file checks made before the instance stopped', async () => {
    const { fake, requestId } = await setup(
      mangaWith(11, [1, 2, 3], [1, 2, 3])
    );
    const base = clientOf(fake);
    let heads = 0;
    clients.set(
      1,
      clientWith(base, {
        headChapterArchive: (chapterId, options) => {
          heads += 1;
          return heads === 2
            ? unreachable('ChapterArchive')()
            : base.headChapterArchive(chapterId, options);
        },
      })
    );

    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 2, instancesFailed: 1 })
    );
    assert.deepStrictEqual(await verifiedOf(requestId), [true, false, false]);
    const manifest = await manifestOf(requestId);
    assert.strictEqual(manifest.progressSignature, null);
    assert.ok(manifest.progressAt);
    assert.strictEqual(await statusOf(requestId), APPROVED);
  });

  it('skips a manga whose read failed and reads the next', async () => {
    const { fake, requestId } = await setup();
    const other = libraryManga(12);
    fake.state.mangas.push(other);
    const second = await seedTitle(fake, other, 9002);
    fake.fault('ChaptersToDownload', 'error');

    assert.deepStrictEqual(
      await poll(),
      ran({ manifests: 2, chapterReads: 1 })
    );
    assert.deepStrictEqual(logged('Manga progress skipped a manga'), [
      [
        'warn',
        {
          label: 'Manga Progress',
          instanceId: 1,
          suwayomiCode: 'UPSTREAM_ERROR',
          operation: 'ChaptersToDownload',
        },
      ],
    ]);
    assert.deepStrictEqual(await countsOf(requestId), {});
    assert.deepStrictEqual(await countsOf(second.requestId), { queued: 3 });
    assert.ok((await manifestOf(requestId)).progressAt);
    assert.ok((await manifestOf(second.requestId)).progressAt);
  });

  it('polls the other instances when one fails', async () => {
    const { fake } = await setup();
    const other = libraryManga(21);
    const fake2 = await start([other], 2);
    configure(
      dispatchInstanceFor(fake.server),
      dispatchInstanceFor(fake2.server, 2)
    );
    await seedTitle(fake2, other, 9002, { instanceId: 2 });
    clients.set(
      1,
      clientWith(clientOf(fake), {
        getAvailability: unreachable('Availability'),
      })
    );

    assert.deepStrictEqual(
      await poll(),
      ran({ manifests: 2, chapterReads: 1, instancesFailed: 1 })
    );
    assert.strictEqual(trackerOf(9002, 2).length, 3);
  });
});

/** Declines a request behind the poll's back, as an admin would. */
const decline = (requestId: number) =>
  dataSource
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status: DECLINED })
    .where({ id: requestId })
    .callListeners(false)
    .execute();

describe('pollMangaProgress: concurrent changes', () => {
  it('rolls a write back when the instance changed during the read', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1], [1]));
    fake.observe((request) => {
      if (request.operationName === 'DownloadedChapters') {
        configure(dispatchInstanceFor(fake.server, 1, { baseUrl: '/moved' }));
      }
    });

    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 1, instancesFailed: 1 })
    );
    assert.deepStrictEqual(logged('Manga progress stopped on an instance'), [
      ['warn', { label: 'Manga Progress', instanceId: 1, errorName: 'Error' }],
    ]);
    assert.deepStrictEqual(await queueStatesOf(requestId), [null]);
    assert.deepStrictEqual(await verifiedOf(requestId), [false]);
    assert.ok((await manifestOf(requestId)).progressAt);
    assert.strictEqual(await statusOf(requestId), APPROVED);
  });

  it('completes nothing when the instance changed before the binding refresh', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1], [1]));
    const original = instanceAdmission.runWithSuwayomiInstanceAdmission;
    const admission = mock.method(
      instanceAdmission,
      'runWithSuwayomiInstanceAdmission',
      ((snapshot, callback) => {
        configure(dispatchInstanceFor(fake.server, 1, { baseUrl: '/moved' }));
        return original(snapshot, callback);
      }) as typeof original
    );

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1, heads: 1 }));
    assert.deepStrictEqual(logged('Manga progress stopped on an instance'), [
      [
        'warn',
        { label: 'Manga Progress', code: 'INSTANCE_CHANGED', instanceId: 1 },
      ],
    ]);
    assert.deepStrictEqual(await verifiedOf(requestId), [true]);
    assert.strictEqual(await statusOf(requestId), APPROVED);

    admission.mock.restore();
    configure(dispatchInstanceFor(fake.server));
    assert.deepStrictEqual(await poll(), ran({ completed: 1 }));
    assert.strictEqual(await statusOf(requestId), COMPLETED);
  });

  const moveDuringRead = async (
    move: (seeded: {
      requestId: number;
      manifestId: number;
    }) => Promise<unknown>
  ) => {
    const { fake, requestId, manifest } = await setup(mangaWith(11, [1], [1]));
    const base = clientOf(fake);
    clients.set(
      1,
      clientWith(base, {
        getDownloadedChapters: async (mangaId, options) => {
          await move({ requestId, manifestId: manifest.id });
          return base.getDownloadedChapters(mangaId, options);
        },
      })
    );

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1, heads: 1 }));
    const after = await manifestOf(requestId);
    assert.strictEqual(after.progressAt, null);
    assert.strictEqual(after.progressSignature, null);
    assert.deepStrictEqual(await queueStatesOf(requestId), [null]);
    assert.deepStrictEqual(await verifiedOf(requestId), [false]);
    return requestId;
  };

  it('writes nothing to a manifest parked during the read', async () => {
    const requestId = await moveDuringRead(({ manifestId }) =>
      getRepository(MangaRequestManifest).update(manifestId, {
        bindingState: MangaRequestBindingState.AWAITING_BINDING,
      })
    );
    assert.strictEqual(await statusOf(requestId), APPROVED);
  });

  it('writes nothing to a request declined during the read', async () => {
    const requestId = await moveDuringRead(({ requestId }) =>
      decline(requestId)
    );
    assert.strictEqual(await statusOf(requestId), DECLINED);
    await waitForBackgroundTasks();
    assert.deepStrictEqual(announced(), []);
  });
});

describe('pollMangaProgress: lock order', () => {
  it('calls Suwayomi holding nothing, and completes without instance admission', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1], [1]));
    const depth = {
      transaction: 0,
      instance: 0,
      request: 0,
      edit: 0,
      media: 0,
    };
    const entries: { name: string; locked: boolean; edit: number }[] = [];
    const enter = (name: string) =>
      entries.push({
        name,
        locked: isInsideMangaProgressLock(),
        edit: depth.edit,
      });

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
    const instance = mock.method(
      instanceAdmission,
      'runWithSuwayomiInstanceAdmission',
      (async (snapshot, callback) => {
        enter('instance');
        depth.instance += 1;
        try {
          return await instanceOriginal(snapshot, callback);
        } finally {
          depth.instance -= 1;
        }
      }) as typeof instanceOriginal
    );
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
      if (Object.values(depth).some((held) => held > 0)) {
        inside.push(sent.operationName ?? sent.method);
      }
    });

    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 1, completed: 1 })
    );
    assert.strictEqual(await statusOf(requestId), COMPLETED);
    assert.deepStrictEqual(inside, []);
    assert.deepStrictEqual(
      entries.filter(({ locked }) => locked),
      [],
      'an admission was entered under the dispatch lock'
    );
    assert.deepStrictEqual(
      entries.filter(({ name, edit }) => name === 'instance' && edit > 0),
      [],
      'the completion entered an instance admission'
    );
    assert.ok(
      entries.some(({ name, edit }) => name === 'media' && edit > 0),
      "the completion took no media admission inside the request's"
    );
    for (const wrapped of [transactions, instance, request, media]) {
      assert.ok(wrapped.mock.callCount() > 0);
    }
  });
});

describe('completeMangaRequest', () => {
  const verified = () => ({
    deliverableAt: new Date(),
    lastQueueState: DOWNLOADED,
    headCheckedAt: new Date(),
  });

  /** A request for `anilistId` on manga `id`, every frozen chapter verified. */
  const delivered = async (
    id: number,
    anilistId: number,
    options: Parameters<typeof seedProgressRequest>[1] = {}
  ) => {
    const seeded = await seedProgressRequest(mangaWith(id, [1, 2], [1, 2]), {
      anilistId,
      mediaStatus: MediaStatus.PROCESSING,
      ...options,
    });
    for (const row of seeded.rows) {
      await setRow(row, verified());
    }
    return { ...seeded, requestId: seeded.request.id };
  };

  it('completes a request once when two polls race', async () => {
    const { requestId } = await setup(mangaWith(11, [1], [1]));

    const runs = await Promise.all([poll(), poll()]);

    assert.strictEqual(
      runs.reduce((sum, { completed }) => sum + completed, 0),
      1
    );
    assert.strictEqual(await statusOf(requestId), COMPLETED);
    await waitForBackgroundTasks();
    assert.deepStrictEqual(announced(), [{ kind: 'media-request', requestId }]);
  });

  it('lets one of two concurrent completions win', async () => {
    const { requestId } = await delivered(11, 9001);

    const results = await Promise.all([
      completeMangaRequest(requestId),
      completeMangaRequest(requestId),
    ]);

    assert.deepStrictEqual(results.sort(), [false, true]);
    assert.strictEqual(await statusOf(requestId), COMPLETED);
    await waitForBackgroundTasks();
    assert.deepStrictEqual(announced(), [{ kind: 'media-request', requestId }]);
  });

  it('completes only an approved manga request with every chapter verified', async () => {
    const flagged = await delivered(12, 9002, {
      manifest: {
        attentionCode: MangaAttentionCode.NOT_IN_LIBRARY,
        attentionAt: new Date(),
      },
    });
    const unverified = await delivered(13, 9003);
    await setRow(unverified.rows[1], { deliverableAt: null });
    const movie = await delivered(14, 9004);
    await dataSource
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ type: MediaType.MOVIE })
      .where({ id: movie.requestId })
      .callListeners(false)
      .execute();
    const declined = await delivered(15, 9005);
    await decline(declined.requestId);
    const empty = await delivered(16, 9006, { numbers: [] });
    const ready = await delivered(17, 9007);

    for (const requestId of [
      999_999,
      flagged.requestId,
      unverified.requestId,
      movie.requestId,
      declined.requestId,
      empty.requestId,
    ]) {
      assert.strictEqual(
        await completeMangaRequest(requestId),
        false,
        `request ${requestId} completed`
      );
    }
    for (const { requestId } of [flagged, unverified, movie, empty]) {
      assert.strictEqual(await statusOf(requestId), APPROVED);
    }
    assert.strictEqual(await statusOf(declined.requestId), DECLINED);

    assert.strictEqual(await completeMangaRequest(ready.requestId), true);
    assert.strictEqual(await statusOf(ready.requestId), COMPLETED);
    await waitForBackgroundTasks();
    assert.deepStrictEqual(announced(), [
      { kind: 'media-request', requestId: ready.requestId },
    ]);
  });

  it('leaves a request declined while the completion waited for its media', async () => {
    const { requestId } = await delivered(11, 9001);
    const original = mediaMutation.runMediaEntityMutation;
    mock.method(mediaMutation, 'runMediaEntityMutation', (async (
      media,
      callback
    ) => {
      await decline(requestId);
      return original(media, callback);
    }) as typeof original);

    assert.strictEqual(await completeMangaRequest(requestId), false);
    assert.strictEqual(await statusOf(requestId), DECLINED);
    await waitForBackgroundTasks();
    assert.deepStrictEqual(announced(), []);
  });
});

describe('pollMangaProgress: media status', () => {
  it('keeps a request open on a title the library already calls available', async () => {
    const { requestId, media } = await setup(libraryManga(11), {
      mediaStatus: MediaStatus.AVAILABLE,
      binding: { availability: MediaStatus.AVAILABLE },
    });

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));

    assert.strictEqual(await statusOf(requestId), APPROVED);
    assert.strictEqual(await mediaStatusOf(media.id), MediaStatus.AVAILABLE);
    await waitForBackgroundTasks();
    assert.deepStrictEqual(announced(), []);
  });

  it('completes a request for part of a title without calling it available', async () => {
    const { requestId, media } = await setup(mangaWith(11, [1, 2, 3], [1]), {
      numbers: [1],
    });

    assert.deepStrictEqual(
      await poll(),
      ran({ chapterReads: 1, heads: 1, completed: 1 })
    );

    assert.strictEqual(await statusOf(requestId), COMPLETED);
    assert.strictEqual(
      await mediaStatusOf(media.id),
      MediaStatus.PARTIALLY_AVAILABLE
    );
    await waitForBackgroundTasks();
    assert.deepStrictEqual(announced(), [{ kind: 'media-request', requestId }]);
  });
});

describe('pollMangaProgress: tracker', () => {
  it('shows only the chapters a request froze', async () => {
    const { fake } = await setup(mangaWith(11, [1, 2, 3]), { numbers: [2] });
    fake.state.queue.push(1101, 1103);

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(trackerOf(), [['Chapter 2', 'queued', 0]]);
  });

  it('names a chapter without a number by its kind alone', async () => {
    await setup(
      libraryManga(11, {
        chapters: [chapterOf({ id: 1101, chapterNumber: -1 })],
      })
    );

    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.deepStrictEqual(trackerOf(), [['Chapter', 'queued', 0]]);
  });

  it("drops a declined request's items on the next poll", async () => {
    const { requestId } = await setup();
    assert.deepStrictEqual(await poll(), ran({ chapterReads: 1 }));
    assert.strictEqual(trackerOf().length, 3);

    await decline(requestId);

    assert.deepStrictEqual(await poll(), ran({ manifests: 0 }));
    assert.deepStrictEqual(trackerOf(), []);
  });
});

describe('mangaProgressPoller', () => {
  it('does nothing while manga is disabled', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1], [1]));
    settings.main.enabledMediaCategories = { ...categories, manga: false };

    await mangaProgressPoller.run();

    assert.deepStrictEqual(fake.server.requests, []);
    assert.deepStrictEqual(logs, []);
    assert.strictEqual(await statusOf(requestId), APPROVED);
  });

  it('polls the configured instances and logs the counts', async () => {
    const { requestId } = await setup(mangaWith(11, [1], [1]));

    await mangaProgressPoller.run();

    assert.deepStrictEqual(logged('Manga progress poll finished'), [
      [
        'debug',
        {
          label: 'Manga Progress',
          manifests: 1,
          chapterReads: 1,
          heads: 1,
          completed: 1,
          instancesFailed: 0,
        },
      ],
    ]);
    assert.strictEqual(await statusOf(requestId), COMPLETED);
    assert.deepStrictEqual(mangaProgressPoller.status(), { running: false });
  });

  it('runs one poll at a time and stops when cancelled', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1], [1]));
    fake.fault('ChaptersToDownload', 'hang');
    let arrived!: () => void;
    const hanging = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    fake.observe((request) => {
      if (request.operationName === 'ChaptersToDownload') arrived();
    });

    const running = mangaProgressPoller.run();
    await hanging;
    assert.deepStrictEqual(mangaProgressPoller.status(), { running: true });
    await mangaProgressPoller.run();
    assert.strictEqual(fake.server.operations('Availability').length, 1);

    mangaProgressPoller.cancel();
    await running;

    assert.deepStrictEqual(logged('Manga progress poll cancelled'), [
      ['info', { label: 'Manga Progress' }],
    ]);
    assert.deepStrictEqual(logged('Manga progress poll finished'), []);
    assert.deepStrictEqual(mangaProgressPoller.status(), { running: false });
    assert.strictEqual((await manifestOf(requestId)).progressAt, null);
    assert.strictEqual(await statusOf(requestId), APPROVED);
  });
});

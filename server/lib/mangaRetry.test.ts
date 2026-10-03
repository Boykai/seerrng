import SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import {
  MangaAttentionCode,
  MangaChapterQueueState,
  MangaRequestBindingState,
  MangaRequestCheckpoint,
} from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import { hashMangaSourceUrl } from '@server/entity/MangaSourceBinding';
import { MediaRequest } from '@server/entity/MediaRequest';
import downloadTracker from '@server/lib/downloadtracker';
import { runWithMangaDispatchLock } from '@server/lib/mangaDispatch';
import { pollMangaProgress } from '@server/lib/mangaProgress';
import {
  MANGA_RETRY_BATCH_SIZE,
  MANGA_RETRY_STATE_MESSAGE,
  MangaRetryRefusedError,
  retryMangaChapters,
  type MangaRetryClient,
} from '@server/lib/mangaRetry';
import notificationManager from '@server/lib/notifications';
import {
  RequestStatusStage,
  getRequestStatusPage,
  recordRequestStatus,
} from '@server/lib/requestStatus';
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
  fakeDispatchChapters,
  fakeDispatchManga,
  seedDispatchBinding,
  type FakeDispatchManga,
} from '@server/test/fakeSuwayomiDispatch';
import {
  PROGRESS_READ_OPERATIONS,
  assertProgressTraffic,
  seedProgressRequest,
  startFakeProgressSuwayomi,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

setupTestDb();

const { QUEUED, ERROR, NOT_QUEUED, DOWNLOADED } = MangaChapterQueueState;
const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const fakes: FakeProgressSuwayomi[] = [];
const clients = new Map<number, SuwayomiAPI>();
let logs: [string, string, Record<string, unknown>][] = [];
/** What the poll reads, plus what a retry sends and the client re-reads. */
const RETRY_OPERATIONS = new Set([
  ...PROGRESS_READ_OPERATIONS,
  'EnqueueChapters',
  // Read back after a failed enqueue, to learn whether it applied.
  'ChapterStates',
]);
/** The reads a retry sends before it queues anything, in order. */
const RETRY_READS = [
  'ByNaturalKey',
  'ChaptersToDownload',
  'DownloadedChapters',
  'Queue',
];

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

const clientOf = (fake: FakeProgressSuwayomi) =>
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
  });

const poll = () => pollMangaProgress({ clientFor: (id) => clients.get(id) });

const retry = (
  requestId: number,
  clientFor: (id: number) => MangaRetryClient | undefined = (id) =>
    clients.get(id)
) => retryMangaChapters(requestId, { clientFor });

const mangaWith = (
  id: number,
  numbers: readonly number[],
  downloaded: readonly number[] = []
) =>
  fakeDispatchManga(id, {
    inLibrary: true,
    chapters: fakeDispatchChapters(id, numbers, downloaded),
  });

/**
 * Instance 1 serving `manga`, AniList 9001 bound to it, and an approved
 * request for 9001 whose dispatch froze every chapter and queued the ones
 * not downloaded yet.
 */
const setup = async (manga: FakeDispatchManga) => {
  const fake = await startFakeProgressSuwayomi([manga]);
  fakes.push(fake);
  clients.set(1, clientOf(fake));
  configure(dispatchInstanceFor(fake.server));
  await seedDispatchBinding(manga);
  const seeded = await seedProgressRequest(manga, {
    mediaStatus: MediaStatus.PROCESSING,
  });
  for (const chapter of manga.chapters) {
    if (!chapter.isDownloaded) fake.state.queue.push(chapter.id);
  }
  return { fake, manga, ...seeded, requestId: seeded.request.id };
};

const manifestOf = (requestId: number) =>
  getRepository(MangaRequestManifest).findOneByOrFail({ requestId });

const rowsOf = async (requestId: number) => {
  const { id } = await manifestOf(requestId);
  return getRepository(MangaRequestChapter).find({
    where: { manifestId: id },
    order: { id: 'ASC' },
  });
};

const queueStatesOf = async (requestId: number) =>
  (await rowsOf(requestId)).map(({ lastQueueState }) => lastQueueState);

const ownedChapters = async () =>
  (
    await getRepository(MangaChapterOwnership).find({ order: { id: 'ASC' } })
  ).map(({ chapterUrlHash }) => chapterUrlHash);

/** Records the poll's verdict on `rows` as if two polls had run. */
const flag = async (
  requestId: number,
  attentionCode: MangaAttentionCode,
  states: (MangaChapterQueueState | null)[]
) => {
  const rows = await rowsOf(requestId);
  for (const [index, row] of rows.entries()) {
    await getRepository(MangaRequestChapter).update(row.id, {
      lastQueueState: states[index] ?? null,
    });
  }
  await getRepository(MangaRequestManifest).update(
    { requestId },
    {
      attentionCode,
      attentionAt: new Date(),
      progressAt: new Date(),
      progressSignature: 'polled',
    }
  );
};

const refused = (message: string | RegExp) => (error: unknown) => {
  assert.ok(error instanceof MangaRetryRefusedError);
  assert.strictEqual(error.status, 409);
  if (typeof message === 'string') {
    assert.strictEqual(error.message, message);
  } else {
    assert.match(error.message, message);
  }
  return true;
};

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  configure();
  logs = [];
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    mock.method(logger, level, (message: unknown, meta?: unknown) => {
      logs.push([
        level,
        String(message),
        (meta ?? {}) as Record<string, unknown>,
      ]);
      return logger;
    });
  }
  mock.method(notificationManager, 'sendNotificationIntent', async () => {
    return;
  });
  downloadTracker.pruneMangaProgress(new Map());
  clients.clear();
});

afterEach(async () => {
  try {
    await waitForBackgroundTasks();
    for (const fake of fakes) {
      assertProgressTraffic(fake.server, RETRY_OPERATIONS);
    }
    // Log lines name codes, counts and IDs: never a URL or a title.
    const text = inspect(logs, {
      depth: 12,
      maxArrayLength: null,
      maxStringLength: null,
    });
    for (const secret of [FAKE_URL_PREFIX, FAKE_TITLE_PREFIX, 'com.example']) {
      assert.ok(!text.includes(secret), `A log line carried ${secret}`);
    }
  } finally {
    mock.restoreAll();
    settings.main.enabledMediaCategories = categories;
    configure();
    downloadTracker.pruneMangaProgress(new Map());
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

describe('retryMangaChapters', () => {
  it('queues a failed chapter exactly once and lets the poll finish the request', async () => {
    const { fake, manga, requestId } = await setup(mangaWith(11, [1, 2]));
    fake.queueItems.set(1101, { state: 'ERROR', tries: 3 });

    await poll();
    const failed = await manifestOf(requestId);
    assert.strictEqual(failed.attentionCode, MangaAttentionCode.CHAPTER_ERROR);
    assert.strictEqual(failed.chaptersErrored, 1);
    const reads = fake.server.requests.length;
    const status = await recordRequestStatus(requestId);
    const page = await getRequestStatusPage({ take: 10, skip: 0 });
    // Status reads come from the manifest; none reaches Suwayomi.
    assert.strictEqual(fake.server.requests.length, reads);
    assert.strictEqual(status?.stage, RequestStatusStage.FAILED);
    assert.strictEqual(status?.retryable, true);
    assert.strictEqual(status?.needsAttention, true);
    assert.strictEqual(status?.percent, 0);
    assert.deepStrictEqual(
      page.results.map(({ status: item }) => item.stage),
      [RequestStatusStage.FAILED]
    );
    const before = fake.operationNames().length;

    assert.deepStrictEqual(await retry(requestId), {
      enqueued: 1,
      candidates: 1,
    });

    assert.deepStrictEqual(fake.operationNames().slice(before), [
      ...RETRY_READS,
      'EnqueueChapters',
    ]);
    assert.deepStrictEqual(fake.enqueuedIds(), [1101]);
    assert.strictEqual(fake.queueItems.has(1101), false);
    assert.deepStrictEqual(await ownedChapters(), [
      hashMangaSourceUrl(manga.chapters[0].url),
    ]);
    const retried = await manifestOf(requestId);
    assert.strictEqual(retried.attentionCode, null);
    assert.strictEqual(retried.attentionAt, null);
    assert.strictEqual(retried.progressSignature, null);
    assert.strictEqual(retried.progressAt, null);
    assert.strictEqual(
      retried.checkpoint,
      MangaRequestCheckpoint.CHAPTERS_ENQUEUED
    );
    assert.strictEqual(retried.chaptersErrored, 0);
    assert.strictEqual(retried.chaptersQueued, 2);
    assert.deepStrictEqual(await queueStatesOf(requestId), [QUEUED, QUEUED]);
    assert.strictEqual(
      (await recordRequestStatus(requestId))?.stage,
      RequestStatusStage.DOWNLOADING
    );
    assert.deepStrictEqual(
      logs.filter(([, message]) => message.includes('administrator')),
      [
        [
          'info',
          'Manga chapters queued again by an administrator',
          {
            label: 'Manga Retry',
            requestId,
            code: MangaAttentionCode.CHAPTER_ERROR,
            count: 1,
            skipped: 0,
          },
        ],
      ]
    );

    // The code is gone, so a second click queues nothing.
    await assert.rejects(retry(requestId), refused(MANGA_RETRY_STATE_MESSAGE));
    assert.deepStrictEqual(fake.enqueuedIds(), [1101]);

    await poll();
    assert.strictEqual((await manifestOf(requestId)).attentionCode, null);
    for (const chapter of manga.chapters) chapter.isDownloaded = true;
    fake.state.queue = [];
    await poll();
    assert.strictEqual(
      (await getRepository(MediaRequest).findOneByOrFail({ id: requestId }))
        .status,
      MediaRequestStatus.COMPLETED
    );
    assert.deepStrictEqual(fake.enqueuedIds(), [1101]);
  });

  it('records ownership before it queues a dropped chapter', async () => {
    const { fake, manga, requestId } = await setup(mangaWith(11, [1, 2]));
    fake.state.queue = fake.state.queue.filter((id) => id !== 1102);

    await poll();
    await poll();
    assert.strictEqual(
      (await manifestOf(requestId)).attentionCode,
      MangaAttentionCode.CHAPTER_NOT_QUEUED
    );
    const base = clients.get(1)!;
    const ownedAtEnqueue: string[][] = [];
    const client: MangaRetryClient = {
      findMangaByNaturalKey: (...args) => base.findMangaByNaturalKey(...args),
      getChaptersToDownload: (...args) => base.getChaptersToDownload(...args),
      getDownloadedChapters: (...args) => base.getDownloadedChapters(...args),
      getQueue: (...args) => base.getQueue(...args),
      enqueueChapters: async (...args) => {
        ownedAtEnqueue.push(await ownedChapters());
        return base.enqueueChapters(...args);
      },
    };

    assert.deepStrictEqual(await retry(requestId, () => client), {
      enqueued: 1,
      candidates: 1,
    });

    const owned = [hashMangaSourceUrl(manga.chapters[1].url)];
    assert.deepStrictEqual(ownedAtEnqueue, [owned]);
    assert.deepStrictEqual(await ownedChapters(), owned);
    assert.deepStrictEqual(fake.enqueuedIds(), [1102]);
    assert.deepStrictEqual(fake.state.queue, [1101, 1102]);
    assert.strictEqual((await manifestOf(requestId)).attentionCode, null);

    await poll();
    assert.deepStrictEqual(await queueStatesOf(requestId), [QUEUED, QUEUED]);
    assert.strictEqual((await manifestOf(requestId)).attentionCode, null);
  });

  it('queues at most fifty chapters per call', async () => {
    const numbers = Array.from({ length: 120 }, (_, index) => index + 1);
    const { fake, requestId } = await setup(mangaWith(11, numbers));
    fake.state.queue = [];
    await flag(
      requestId,
      MangaAttentionCode.CHAPTER_NOT_QUEUED,
      numbers.map(() => NOT_QUEUED)
    );

    assert.deepStrictEqual(await retry(requestId), {
      enqueued: 120,
      candidates: 120,
    });

    assert.deepStrictEqual(
      fake.server
        .operations('EnqueueChapters')
        .map(({ variables }) => (variables.ids as unknown[]).length),
      [MANGA_RETRY_BATCH_SIZE, MANGA_RETRY_BATCH_SIZE, 20]
    );
    assert.strictEqual(new Set(fake.enqueuedIds()).size, 120);
    assert.strictEqual((await ownedChapters()).length, 120);
    assert.strictEqual((await manifestOf(requestId)).chaptersQueued, 120);
  });

  it('skips chapters that were downloaded, queued again or are no longer listed', async () => {
    const { fake, manga, requestId } = await setup(
      mangaWith(11, [1, 2, 3, 4, 5])
    );
    await flag(requestId, MangaAttentionCode.CHAPTER_ERROR, [
      ERROR,
      ERROR,
      NOT_QUEUED,
      NOT_QUEUED,
      DOWNLOADED,
    ]);
    // 1 was downloaded since, 2 still failed, 3 queued again by someone,
    // 4 gone from the source; 5 is no candidate.
    manga.chapters[0].isDownloaded = true;
    fake.state.queue = [1102, 1103];
    fake.queueItems.set(1102, { state: 'ERROR', tries: 3 });
    manga.chapters.splice(3, 1);

    assert.deepStrictEqual(await retry(requestId), {
      enqueued: 1,
      candidates: 4,
    });

    assert.deepStrictEqual(fake.enqueuedIds(), [1102]);
    assert.deepStrictEqual(await queueStatesOf(requestId), [
      ERROR,
      QUEUED,
      NOT_QUEUED,
      NOT_QUEUED,
      DOWNLOADED,
    ]);
    const manifest = await manifestOf(requestId);
    assert.strictEqual(manifest.attentionCode, null);
    assert.strictEqual(manifest.chaptersErrored, 1);
    assert.strictEqual(manifest.chaptersQueued, 1);
    assert.strictEqual(manifest.chaptersMissing, 2);
    assert.strictEqual(manifest.chaptersDownloading, 1);
  });

  it('refuses a request that has nothing a retry can fix', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1]));
    const update = (values: Partial<MangaRequestManifest>) =>
      getRepository(MangaRequestManifest).update({ requestId }, values);

    await assert.rejects(retry(requestId), refused(MANGA_RETRY_STATE_MESSAGE));
    for (const attentionCode of [
      MangaAttentionCode.BINDING_ORPHANED,
      MangaAttentionCode.NOT_IN_LIBRARY,
      MangaAttentionCode.CHAPTER_FILE_MISSING,
    ]) {
      await update({ attentionCode });
      await assert.rejects(
        retry(requestId),
        refused(MANGA_RETRY_STATE_MESSAGE)
      );
    }

    await update({ attentionCode: MangaAttentionCode.CHAPTER_ERROR });
    await update({
      bindingState: MangaRequestBindingState.AWAITING_BINDING,
    });
    await assert.rejects(retry(requestId), refused(MANGA_RETRY_STATE_MESSAGE));
    await update({
      bindingState: MangaRequestBindingState.BOUND,
      checkpoint: MangaRequestCheckpoint.MANIFEST_FROZEN,
    });
    await assert.rejects(retry(requestId), refused(MANGA_RETRY_STATE_MESSAGE));
    await update({ checkpoint: MangaRequestCheckpoint.CHAPTERS_ENQUEUED });
    await getRepository(MediaRequest).update(requestId, {
      status: MediaRequestStatus.DECLINED,
    });
    await assert.rejects(retry(requestId), refused(MANGA_RETRY_STATE_MESSAGE));
    await getRepository(MediaRequest).update(requestId, {
      status: MediaRequestStatus.APPROVED,
    });

    configure();
    await assert.rejects(retry(requestId), refused(/no longer configured/));
    assert.deepStrictEqual(fake.operationNames(), []);
  });

  it('refuses when Suwayomi no longer has the manga', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1]));
    await flag(requestId, MangaAttentionCode.CHAPTER_ERROR, [ERROR]);
    fake.state.mangas = [];

    await assert.rejects(retry(requestId), refused(/no longer has/));
    assert.deepStrictEqual(fake.operationNames(), ['ByNaturalKey']);
    assert.strictEqual(
      (await manifestOf(requestId)).attentionCode,
      MangaAttentionCode.CHAPTER_ERROR
    );
  });

  it('passes a failed Suwayomi read on and changes nothing', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1]));
    fake.queueItems.set(1101, { state: 'ERROR', tries: 3 });
    await flag(requestId, MangaAttentionCode.CHAPTER_ERROR, [ERROR]);
    fake.failNext('Queue');

    await assert.rejects(retry(requestId), (error: unknown) => {
      assert.ok(error instanceof SuwayomiError);
      assert.strictEqual(error.retryable, true);
      return true;
    });

    assert.deepStrictEqual(fake.enqueuedIds(), []);
    assert.deepStrictEqual(await ownedChapters(), []);
    assert.strictEqual(
      (await manifestOf(requestId)).attentionCode,
      MangaAttentionCode.CHAPTER_ERROR
    );
  });

  it('stays retryable when Suwayomi fails to queue, and a second retry finishes the job', async () => {
    const { fake, manga, requestId } = await setup(mangaWith(11, [1, 2]));
    fake.state.queue = [1101];
    await flag(requestId, MangaAttentionCode.CHAPTER_NOT_QUEUED, [
      QUEUED,
      NOT_QUEUED,
    ]);
    fake.fault('EnqueueChapters', 'error');

    await assert.rejects(retry(requestId), SuwayomiError);

    // The ownership row stays, so L11's release can still take it back.
    const owned = [hashMangaSourceUrl(manga.chapters[1].url)];
    assert.deepStrictEqual(await ownedChapters(), owned);
    assert.deepStrictEqual(fake.state.queue, [1101]);
    assert.strictEqual(
      (await manifestOf(requestId)).attentionCode,
      MangaAttentionCode.CHAPTER_NOT_QUEUED
    );
    assert.deepStrictEqual(await queueStatesOf(requestId), [
      QUEUED,
      NOT_QUEUED,
    ]);

    assert.deepStrictEqual(await retry(requestId), {
      enqueued: 1,
      candidates: 1,
    });
    assert.deepStrictEqual(await ownedChapters(), owned);
    assert.deepStrictEqual(fake.state.queue, [1101, 1102]);
    assert.strictEqual((await manifestOf(requestId)).attentionCode, null);
  });

  it('queues nothing and records nothing when the instance changed during the reads', async () => {
    const { fake, requestId } = await setup(mangaWith(11, [1]));
    fake.queueItems.set(1101, { state: 'ERROR', tries: 3 });
    await flag(requestId, MangaAttentionCode.CHAPTER_ERROR, [ERROR]);
    const base = clients.get(1)!;
    const client: MangaRetryClient = {
      findMangaByNaturalKey: (...args) => base.findMangaByNaturalKey(...args),
      getChaptersToDownload: (...args) => base.getChaptersToDownload(...args),
      getDownloadedChapters: (...args) => base.getDownloadedChapters(...args),
      getQueue: async (...args) => {
        configure(dispatchInstanceFor(fake.server, 1, { baseUrl: '/moved' }));
        return base.getQueue(...args);
      },
      enqueueChapters: (...args) => base.enqueueChapters(...args),
    };

    await assert.rejects(
      retry(requestId, () => client),
      instanceAdmission.SuwayomiInstanceChangedError
    );

    assert.deepStrictEqual(fake.enqueuedIds(), []);
    assert.deepStrictEqual(await ownedChapters(), []);
    assert.strictEqual(
      (await manifestOf(requestId)).attentionCode,
      MangaAttentionCode.CHAPTER_ERROR
    );
  });

  it('waits for the dispatch lock of its manga and takes no instance admission', async () => {
    const { fake, manga, requestId } = await setup(mangaWith(11, [1]));
    fake.queueItems.set(1101, { state: 'ERROR', tries: 3 });
    await flag(requestId, MangaAttentionCode.CHAPTER_ERROR, [ERROR]);
    const admission = mock.method(
      instanceAdmission,
      'runWithSuwayomiInstanceAdmission'
    );
    let release!: () => void;
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = runWithMangaDispatchLock(
      1,
      manga.sourceId,
      hashMangaSourceUrl(manga.url),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        })
    );
    await holding;

    const retried = retry(requestId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(fake.operationNames(), []);
    release();
    await held;

    assert.deepStrictEqual(await retried, { enqueued: 1, candidates: 1 });
    assert.deepStrictEqual(fake.enqueuedIds(), [1101]);
    assert.strictEqual(admission.mock.callCount(), 0);
  });
});

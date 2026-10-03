import { MangaRequestCheckpoint } from '@server/constants/mangaRequest';
import { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import { hashMangaSourceUrl } from '@server/entity/MangaSourceBinding';
import {
  graphqlData,
  graphqlErrors,
  syntheticFailure,
  type FakeReply,
  type FakeRequest,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import {
  seedDispatchRequest,
  startFakeDispatchSuwayomi,
  type FakeDispatchChapter,
  type FakeDispatchManga,
  type FakeDispatchObserver,
  type FakeDispatchSuwayomi,
  type SeededDispatchRequest,
} from '@server/test/fakeSuwayomiDispatch';
import assert from 'node:assert/strict';

/**
 * The dispatch fake plus what the progress poll reads: the availability
 * batch, a queue whose items can be downloading or failed, chapter archives
 * behind HEAD, and when each manga's chapters were last fetched. All values
 * are invented.
 */

export type FakeQueueState = 'QUEUED' | 'DOWNLOADING' | 'ERROR' | 'FINISHED';

export interface FakeQueueItem {
  state: FakeQueueState;
  /** A fraction, as Suwayomi reports it. */
  progress?: number;
  tries?: number;
}

export interface FakeProgressSuwayomi extends FakeDispatchSuwayomi {
  /** Queue item states by chapter ID; a queued chapter without one is QUEUED. */
  queueItems: Map<number, FakeQueueItem>;
  /** HEAD replies by chapter ID, over the default for the chapter's state. */
  archives: Map<number, FakeReply>;
  /** `chaptersLastFetchedAt` by manga ID, epoch seconds as text. */
  fetchedAt: Map<number, string>;
  /** Fails the next calls of a read this fake serves with a GraphQL error. */
  failNext(operation: 'Availability' | 'Queue' | 'ByNaturalKey'): void;
  /** Adds a chapter to a manga and serves its archive. */
  addChapter(mangaId: number, chapter: FakeDispatchChapter): void;
  /** Serves an archive route for every chapter the state holds now. */
  serveArchives(): void;
  /** Chapter IDs every HEAD asked for, in order. */
  headIds(): number[];
}

/** Archive bytes a downloaded chapter reports by default. */
export const FAKE_ARCHIVE_BYTES = 4_096;
export const FAKE_FETCHED_AT = '1700000000';

/** Every operation the poll may send; none of them writes. */
export const PROGRESS_READ_OPERATIONS = new Set([
  'Availability',
  'ByNaturalKey',
  'ChaptersToDownload',
  'DownloadedChapters',
  'Queue',
]);

const ARCHIVE_ROUTE = /^\/api\/v1\/chapter\/(\d+)\/download$/;

const zip = (length: number): FakeReply => ({
  status: 200,
  headers: { 'Content-Type': 'application/zip', 'Content-Length': `${length}` },
});

/** A HEAD answer without a size, as a proxy that strips it would send. */
export const noLengthArchive: FakeReply = {
  status: 200,
  headers: { 'Content-Type': 'application/zip' },
};

export const emptyArchive = zip(0);

export const sizedArchive = (length: number) => zip(length);

export const startFakeProgressSuwayomi = async (
  mangas: FakeDispatchManga[] = []
): Promise<FakeProgressSuwayomi> => {
  const fake = await startFakeDispatchSuwayomi(mangas);
  const { server, state } = fake;
  const queueItems = new Map<number, FakeQueueItem>();
  const archives = new Map<number, FakeReply>();
  const fetchedAt = new Map<number, string>();
  const failures = new Map<string, number>();
  const observers: FakeDispatchObserver[] = [];

  const find = (id: unknown) =>
    state.mangas.find((manga) => manga.id === Number(id));
  const chapterById = (id: number) => {
    for (const manga of state.mangas) {
      const chapter = manga.chapters.find((entry) => entry.id === id);
      if (chapter) return { manga, chapter };
    }
    return undefined;
  };
  const counts = (manga: FakeDispatchManga) => ({
    inLibrary: manga.inLibrary,
    downloadCount: manga.chapters.filter((chapter) => chapter.isDownloaded)
      .length,
    hasDuplicateChapters: false,
    chaptersLastFetchedAt: fetchedAt.get(manga.id) ?? FAKE_FETCHED_AT,
    chapters: { totalCount: manga.chapters.length },
  });
  const queueNode = () => ({
    state: state.downloader,
    queue: state.queue.flatMap((chapterId) => {
      const found = chapterById(chapterId);
      if (!found) return [];
      const item = queueItems.get(chapterId);
      return [
        {
          state: item?.state ?? 'QUEUED',
          progress: item?.progress ?? 0,
          tries: item?.tries ?? 0,
          chapter: { id: chapterId, mangaId: found.manga.id },
        },
      ];
    }),
  });

  const serve = (
    name: string,
    reply: (request: FakeRequest) => FakeReply
  ): void => {
    server.onOperation(name, (request) => {
      for (const observer of observers) observer(request);
      const failing = failures.get(name) ?? 0;
      if (failing > 0) {
        failures.set(name, failing - 1);
        return graphqlErrors([syntheticFailure()]);
      }
      return reply(request);
    });
  };
  serve('Availability', (request) =>
    graphqlData({
      mangas: {
        nodes: (Array.isArray(request.variables.ids)
          ? request.variables.ids
          : []
        ).flatMap((id) => {
          const manga = find(id);
          return manga
            ? [{ id: manga.id, status: 'ONGOING', ...counts(manga) }]
            : [];
        }),
      },
      downloadStatus: queueNode(),
    })
  );
  serve('Queue', () => graphqlData({ downloadStatus: queueNode() }));
  serve('ByNaturalKey', (request) =>
    graphqlData({
      mangas: {
        nodes: state.mangas
          .filter(
            (manga) =>
              manga.sourceId === String(request.variables.sourceId) &&
              manga.url === request.variables.url
          )
          .map((manga) => ({
            id: manga.id,
            sourceId: manga.sourceId,
            url: manga.url,
            title: manga.title,
            status: 'ONGOING',
            initialized: true,
            meta: Object.entries(manga.meta).map(([key, value]) => ({
              key,
              value,
            })),
            ...counts(manga),
          })),
      },
    })
  );
  // Enqueueing a failed chapter again buys it a fresh attempt.
  fake.observe((request) => {
    if (request.operationName !== 'EnqueueChapters') return;
    for (const id of Array.isArray(request.variables.ids)
      ? request.variables.ids
      : []) {
      queueItems.delete(Number(id));
    }
  });

  const serveArchive = (chapterId: number): void => {
    server.onRoute(
      'HEAD',
      `/api/v1/chapter/${chapterId}/download`,
      (request) => {
        for (const observer of observers) observer(request);
        const override = archives.get(chapterId);
        if (override) return override;
        const found = chapterById(chapterId);
        return found?.chapter.isDownloaded
          ? zip(FAKE_ARCHIVE_BYTES)
          : found
            ? emptyArchive
            : { status: 404 };
      }
    );
  };
  const serveArchives = () => {
    for (const manga of state.mangas) {
      for (const chapter of manga.chapters) serveArchive(chapter.id);
    }
  };
  serveArchives();

  return {
    ...fake,
    queueItems,
    archives,
    fetchedAt,
    observe: (observer) => {
      fake.observe(observer);
      observers.push(observer);
    },
    failNext: (operation) => {
      failures.set(operation, (failures.get(operation) ?? 0) + 1);
    },
    addChapter: (mangaId, chapter) => {
      fake.manga(mangaId).chapters.push(chapter);
      serveArchive(chapter.id);
    },
    serveArchives,
    headIds: () =>
      server.requests.flatMap((request) => {
        const match =
          request.method === 'HEAD'
            ? ARCHIVE_ROUTE.exec(new URL(request.url, server.url).pathname)
            : null;
        return match ? [Number(match[1])] : [];
      }),
  };
};

/** The poll only reads: chapter lists, the queue, availability and HEADs. */
export const assertProgressTraffic = (
  server: FakeSuwayomi,
  allowed: ReadonlySet<string> = PROGRESS_READ_OPERATIONS
): void => {
  for (const request of server.requests) {
    if (request.method === 'HEAD') {
      assert.match(new URL(request.url, server.url).pathname, ARCHIVE_ROUTE);
      continue;
    }
    const name = request.operationName;
    assert.ok(
      name !== undefined && allowed.has(name),
      `Unexpected Suwayomi operation ${String(name)}`
    );
  }
};

export interface SeededProgressRequest extends SeededDispatchRequest {
  rows: MangaRequestChapter[];
}

/**
 * An approved request whose manifest dispatch enqueued on `manga`, frozen to
 * the chapters numbered `numbers` (all of them by default). `owned` adds
 * L11's ownership row for each frozen chapter.
 */
export const seedProgressRequest = async (
  manga: FakeDispatchManga,
  {
    numbers,
    owned = false,
    ...options
  }: Parameters<typeof seedDispatchRequest>[0] & {
    numbers?: readonly number[];
    owned?: boolean;
  } = {}
): Promise<SeededProgressRequest> => {
  const seeded = await seedDispatchRequest({
    ...options,
    manifest: {
      checkpoint: MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
      checkpointAt: new Date(),
      frozenAt: new Date(),
      bindingSourceId: manga.sourceId,
      bindingUrlHash: hashMangaSourceUrl(manga.url),
      suwayomiMangaId: manga.id,
      ...options.manifest,
    },
  });
  const frozen = manga.chapters.filter(
    ({ chapterNumber }) => !numbers || numbers.includes(chapterNumber)
  );
  const rows = await getRepository(MangaRequestChapter).save(
    frozen.map(
      (chapter) =>
        new MangaRequestChapter({
          manifestId: seeded.manifest.id,
          url: chapter.url,
          urlHash: hashMangaSourceUrl(chapter.url),
          chapterNumber: chapter.chapterNumber,
          scanlator: chapter.scanlator ?? null,
        })
    )
  );
  if (owned) {
    await getRepository(MangaChapterOwnership).save(
      frozen.map(
        (chapter) =>
          new MangaChapterOwnership({
            instanceId: seeded.manifest.instanceId,
            sourceId: manga.sourceId,
            mangaUrlHash: hashMangaSourceUrl(manga.url),
            chapterUrlHash: hashMangaSourceUrl(chapter.url),
            chapterUrl: chapter.url,
          })
      )
    );
  }
  return { ...seeded, rows };
};

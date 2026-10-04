import SuwayomiAPI from '@server/api/suwayomi';
import {
  INSTANCE_MARKER_KEY,
  REQUEST_INDEX_PREFIX,
  REQUEST_STAMP_KEY,
} from '@server/api/suwayomi/operations';
import type { SuwayomiTimeouts } from '@server/api/suwayomi/types';
import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { createMangaMedia } from '@server/lib/mangaMedia';
import { DEFAULT_MANGA_REQUEST_SCOPE } from '@server/lib/mangaRequests';
import type { SuwayomiSettings } from '@server/lib/settings';
import {
  graphqlData,
  graphqlErrors,
  missingLookup,
  serveFakeLibrary,
  startFakeSuwayomi,
  syntheticFailure,
  type FakeLibrary,
  type FakeLibraryManga,
  type FakeReply,
  type FakeRequest,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import assert from 'node:assert/strict';

/**
 * A stateful Suwayomi for dispatch tests: library flags, categories, manga
 * and global meta, chapters and the download queue live in `state` and every
 * write changes them, so a test can replay a run against what an earlier one
 * left. All values are invented.
 */

export interface FakeDispatchChapter {
  id: number;
  url: string;
  chapterNumber: number;
  scanlator?: string;
  /** Epoch milliseconds. */
  uploadDate?: number;
  isDownloaded: boolean;
}

export interface FakeDispatchManga {
  id: number;
  sourceId: string;
  url: string;
  title: string;
  inLibrary: boolean;
  /** Manga meta by key, as the server stores it. */
  meta: Record<string, string>;
  categoryIds: number[];
  chapters: FakeDispatchChapter[];
  trackRecords?: { trackerId: number; remoteId: string }[];
}

export interface FakeDispatchCategory {
  id: number;
  name: string;
}

export interface FakeDispatchState {
  mangas: FakeDispatchManga[];
  categories: FakeDispatchCategory[];
  globalMeta: Map<string, string>;
  /** Queued chapter IDs, in queue order. */
  queue: number[];
  downloader: 'STARTED' | 'STOPPED';
}

/**
 * How the next call of an operation fails. `applied-*` faults change the
 * state first, as a server that crashed or stalled after its write would.
 * `error` is a GraphQL error; `applied-error` an HTTP 500 the client does not
 * read back; `hang` never answers; `partial` (fetch only) returns the data
 * with an error beside it.
 */
export type FakeDispatchFault =
  'error' | 'applied-error' | 'hang' | 'applied-hang' | 'partial';

export type FakeDispatchObserver = (request: FakeRequest) => void;

export interface FakeDispatchSuwayomi {
  server: FakeSuwayomi;
  state: FakeDispatchState;
  /** Queues faults for the next calls of `operation`. */
  fault(operation: string, ...faults: FakeDispatchFault[]): void;
  /** Runs before every operation is applied, faults included. */
  observe(observer: FakeDispatchObserver): void;
  manga(id: number): FakeDispatchManga;
  /** The manga's parsed request stamp, undefined when it has none. */
  stamp(id: number): unknown;
  /** The parsed request-index entry of a request, undefined when absent. */
  indexEntry(requestId: number): unknown;
  /** Operation names in the order they arrived. */
  operationNames(): string[];
  writes(): FakeRequest[];
  /** Every chapter ID any EnqueueChapters call carried, repeats included. */
  enqueuedIds(): number[];
  close(): Promise<void>;
}

/** Every operation dispatch, release and the library scan may send. */
export const DISPATCH_ALLOWED_OPERATIONS = new Set([
  'AddMangaToCategory',
  'ByNaturalKey',
  'Capabilities',
  'ChapterStates',
  'ChaptersToDownload',
  'CreateCategory',
  'DeleteRequestIndex',
  'DequeueChapters',
  'DownloadedChapters',
  'EnqueueChapters',
  'FetchMangaAndChapters',
  'FindCategory',
  'InstanceMarker',
  'LibraryChapterStates',
  'LibraryPage',
  'LibraryTrackRecords',
  'MangaDetails',
  'Queue',
  'ReverseIndex',
  'SetInLibrary',
  'SetInstanceMarker',
  'SetRequestIndex',
  'SetRequestStamp',
]);

export const DISPATCH_WRITE_OPERATIONS = new Set([
  'AddMangaToCategory',
  'CreateCategory',
  'DeleteRequestIndex',
  'DequeueChapters',
  'EnqueueChapters',
  'SetInLibrary',
  'SetInstanceMarker',
  'SetRequestIndex',
  'SetRequestStamp',
]);

/** Invented natural-key values; nothing names a real source. */
export const FAKE_SOURCE_ID = '1002';
export const FAKE_TITLE_PREFIX = 'Fake Dispatch Title';
export const FAKE_URL_PREFIX = '/fake-dispatch/';

export const fakeMangaUrl = (key: number | string) =>
  `${FAKE_URL_PREFIX}manga-${key}`;

export const fakeChapterUrl = (mangaId: number, chapterNumber: number) =>
  `${FAKE_URL_PREFIX}manga-${mangaId}/chapter-${chapterNumber}`;

/** Chapters `numbers` of a manga, IDs `mangaId * 100 + number`. */
export const fakeDispatchChapters = (
  mangaId: number,
  numbers: readonly number[],
  downloaded: readonly number[] = []
): FakeDispatchChapter[] =>
  numbers.map((chapterNumber) => ({
    id: mangaId * 100 + chapterNumber,
    url: fakeChapterUrl(mangaId, chapterNumber),
    chapterNumber,
    isDownloaded: downloaded.includes(chapterNumber),
  }));

export const fakeDispatchManga = (
  id: number,
  overrides: Partial<FakeDispatchManga> = {}
): FakeDispatchManga => ({
  id,
  sourceId: FAKE_SOURCE_ID,
  url: fakeMangaUrl(id),
  title: `${FAKE_TITLE_PREFIX} ${id}`,
  inLibrary: false,
  meta: {},
  categoryIds: [],
  chapters: fakeDispatchChapters(id, [1, 2, 3]),
  ...overrides,
});

const detailNode = (manga: FakeDispatchManga) => ({
  id: manga.id,
  sourceId: manga.sourceId,
  url: manga.url,
  title: manga.title,
  status: 'ONGOING',
  inLibrary: manga.inLibrary,
  initialized: true,
  downloadCount: manga.chapters.filter((chapter) => chapter.isDownloaded)
    .length,
  hasDuplicateChapters: false,
  chapters: { totalCount: manga.chapters.length },
  meta: Object.entries(manga.meta).map(([key, value]) => ({ key, value })),
});

const chapterNode = (
  manga: FakeDispatchManga,
  chapter: FakeDispatchChapter,
  sourceOrder: number
) => ({
  id: chapter.id,
  mangaId: manga.id,
  url: chapter.url,
  name: `Fake Chapter ${chapter.chapterNumber}`,
  chapterNumber: chapter.chapterNumber,
  scanlator: chapter.scanlator ?? null,
  uploadDate: String(chapter.uploadDate ?? 1_700_000_000_000 + sourceOrder),
  sourceOrder,
  pageCount: 0,
  isDownloaded: chapter.isDownloaded,
});

const categoryNode = (category: FakeDispatchCategory) => ({
  id: category.id,
  name: category.name,
  includeInUpdate: 'UNSET',
  includeInDownload: 'UNSET',
});

const idsOf = (request: FakeRequest): number[] =>
  (Array.isArray(request.variables.ids) ? request.variables.ids : []).map(
    Number
  );

const parseJson = (value: string | undefined): unknown => {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/**
 * Starts the fake with `mangas`. It also serves the library-scan reads from
 * the same state, so a scan sees what dispatch changed.
 */
export const startFakeDispatchSuwayomi = async (
  mangas: FakeDispatchManga[] = []
): Promise<FakeDispatchSuwayomi> => {
  const server = await startFakeSuwayomi({ mode: 'NONE' });
  const state: FakeDispatchState = {
    mangas,
    categories: [],
    globalMeta: new Map(),
    queue: [],
    downloader: 'STOPPED',
  };
  const faults = new Map<string, FakeDispatchFault[]>();
  const observers: FakeDispatchObserver[] = [];
  let nextCategoryId = 1;

  const find = (id: unknown) =>
    state.mangas.find((manga) => manga.id === Number(id));
  const chapterById = (id: number) => {
    for (const manga of state.mangas) {
      const chapter = manga.chapters.find((entry) => entry.id === id);
      if (chapter) {
        return { manga, chapter };
      }
    }
    return undefined;
  };
  const queueNode = () => ({
    state: state.downloader,
    queue: state.queue.flatMap((chapterId) => {
      const found = chapterById(chapterId);
      return found
        ? [
            {
              state: 'QUEUED',
              progress: 0,
              tries: 0,
              chapter: { id: chapterId, mangaId: found.manga.id },
            },
          ]
        : [];
    }),
  });
  const chapterList = (
    request: FakeRequest,
    downloaded: boolean
  ): FakeReply => {
    const manga = find(request.variables.mangaId);
    return graphqlData({
      chapters: {
        nodes: manga
          ? manga.chapters.flatMap((chapter, index) =>
              chapter.isDownloaded === downloaded
                ? [chapterNode(manga, chapter, index)]
                : []
            )
          : [],
      },
    });
  };

  /**
   * Applies an operation and returns its reply. Reads have no `apply`
   * effect, so `applied-*` faults behave like the plain ones for them.
   */
  const operations: Record<
    string,
    {
      apply?: (request: FakeRequest) => void;
      reply: (request: FakeRequest) => FakeReply;
    }
  > = {
    ByNaturalKey: {
      reply: (request) =>
        graphqlData({
          mangas: {
            nodes: state.mangas
              .filter(
                (manga) =>
                  manga.sourceId === String(request.variables.sourceId) &&
                  manga.url === request.variables.url
              )
              .map(detailNode),
          },
        }),
    },
    MangaDetails: {
      reply: (request) => {
        const manga = find(request.variables.id);
        return manga
          ? graphqlData({ manga: detailNode(manga) })
          : missingLookup('manga');
      },
    },
    FindCategory: {
      reply: (request) =>
        graphqlData({
          categories: {
            nodes: state.categories
              .filter((category) => category.name === request.variables.name)
              .map(categoryNode),
          },
        }),
    },
    CreateCategory: {
      apply: (request) => {
        state.categories.push({
          id: nextCategoryId++,
          name: String(request.variables.name),
        });
      },
      reply: () =>
        graphqlData({
          createCategory: {
            category: categoryNode(
              state.categories[state.categories.length - 1]
            ),
          },
        }),
    },
    SetInLibrary: {
      apply: (request) => {
        const manga = find(request.variables.id);
        if (manga) {
          manga.inLibrary = request.variables.inLibrary === true;
        }
      },
      reply: (request) => {
        const manga = find(request.variables.id);
        return manga
          ? graphqlData({
              updateManga: {
                manga: { id: manga.id, inLibrary: manga.inLibrary },
              },
            })
          : missingLookup('updateManga');
      },
    },
    AddMangaToCategory: {
      apply: (request) => {
        const manga = find(request.variables.id);
        const categoryId = Number(request.variables.categoryId);
        if (manga && !manga.categoryIds.includes(categoryId)) {
          manga.categoryIds.push(categoryId);
        }
      },
      reply: (request) =>
        graphqlData({
          updateMangaCategories: {
            manga: { id: Number(request.variables.id) },
          },
        }),
    },
    SetRequestStamp: {
      apply: (request) => {
        const manga = find(request.variables.mangaId);
        if (manga) {
          manga.meta[REQUEST_STAMP_KEY] = String(request.variables.value);
        }
      },
      reply: (request) =>
        graphqlData({
          setMangaMeta: {
            meta: { key: REQUEST_STAMP_KEY, value: request.variables.value },
          },
        }),
    },
    SetRequestIndex: {
      apply: (request) => {
        state.globalMeta.set(
          String(request.variables.key),
          String(request.variables.value)
        );
      },
      reply: (request) =>
        graphqlData({
          setGlobalMeta: {
            meta: {
              key: request.variables.key,
              value: request.variables.value,
            },
          },
        }),
    },
    DeleteRequestIndex: {
      apply: (request) => {
        state.globalMeta.delete(String(request.variables.key));
      },
      reply: (request) =>
        graphqlData({
          deleteGlobalMeta: { meta: { key: request.variables.key, value: '' } },
        }),
    },
    SetInstanceMarker: {
      apply: (request) => {
        state.globalMeta.set(
          INSTANCE_MARKER_KEY,
          String(request.variables.value)
        );
      },
      reply: (request) =>
        graphqlData({
          setGlobalMeta: {
            meta: { key: INSTANCE_MARKER_KEY, value: request.variables.value },
          },
        }),
    },
    InstanceMarker: {
      reply: () => {
        const value = state.globalMeta.get(INSTANCE_MARKER_KEY);
        return value === undefined
          ? missingLookup('meta')
          : graphqlData({ meta: { key: INSTANCE_MARKER_KEY, value } });
      },
    },
    ReverseIndex: {
      reply: (request) => {
        const after =
          typeof request.variables.after === 'string'
            ? request.variables.after
            : '';
        const keys = [...state.globalMeta.keys()]
          .filter((key) => key.startsWith(REQUEST_INDEX_PREFIX) && key > after)
          .sort();
        const page = keys.slice(0, 2);
        return graphqlData({
          metas: {
            pageInfo: {
              hasNextPage: keys.length > page.length,
              endCursor: page[page.length - 1] ?? null,
            },
            nodes: page.map((key) => ({
              key,
              value: state.globalMeta.get(key),
            })),
          },
        });
      },
    },
    ChaptersToDownload: { reply: (request) => chapterList(request, false) },
    DownloadedChapters: { reply: (request) => chapterList(request, true) },
    ChapterStates: {
      reply: (request) =>
        graphqlData({
          chapters: {
            nodes: idsOf(request).flatMap((id) => {
              const found = chapterById(id);
              return found
                ? [
                    {
                      id,
                      mangaId: found.manga.id,
                      isDownloaded: found.chapter.isDownloaded,
                    },
                  ]
                : [];
            }),
          },
        }),
    },
    Queue: { reply: () => graphqlData({ downloadStatus: queueNode() }) },
    EnqueueChapters: {
      apply: (request) => {
        for (const id of idsOf(request)) {
          const found = chapterById(id);
          if (
            found &&
            !found.chapter.isDownloaded &&
            !state.queue.includes(id)
          ) {
            state.queue.push(id);
          }
        }
      },
      reply: () =>
        graphqlData({
          enqueueChapterDownloads: {
            downloadStatus: { state: state.downloader },
          },
        }),
    },
    DequeueChapters: {
      apply: (request) => {
        const ids = new Set(idsOf(request));
        state.queue = state.queue.filter((id) => !ids.has(id));
      },
      reply: () =>
        graphqlData({
          dequeueChapterDownloads: {
            downloadStatus: { state: state.downloader },
          },
        }),
    },
    FetchMangaAndChapters: {
      reply: (request) => {
        const manga = find(request.variables.id);
        return manga
          ? graphqlData({
              fetchMangaAndChapters: {
                manga: detailNode(manga),
                chapters: manga.chapters.map((chapter, index) =>
                  chapterNode(manga, chapter, index)
                ),
              },
            })
          : missingLookup('fetchMangaAndChapters');
      },
    },
  };

  const libraryManga = (manga: FakeDispatchManga): FakeLibraryManga => ({
    id: manga.id,
    sourceId: manga.sourceId,
    url: manga.url,
    title: manga.title,
    chapters: manga.chapters.map(({ chapterNumber, isDownloaded }) => ({
      chapterNumber,
      isDownloaded,
    })),
    trackRecords: manga.trackRecords,
  });
  const library: FakeLibrary = {
    get mangas() {
      return state.mangas.filter((manga) => manga.inLibrary).map(libraryManga);
    },
    get outside() {
      return state.mangas.filter((manga) => !manga.inLibrary).map(libraryManga);
    },
  };
  serveFakeLibrary(server, library);

  for (const [name, operation] of Object.entries(operations)) {
    server.onOperation(name, (request) => {
      for (const observer of observers) {
        observer(request);
      }
      const fault = faults.get(name)?.shift();
      if (fault === 'error') {
        return graphqlErrors([syntheticFailure()]);
      }
      if (fault === 'hang') {
        return { hang: true };
      }
      operation.apply?.(request);
      if (fault === 'applied-error') {
        return { status: 500, body: syntheticFailure() };
      }
      if (fault === 'applied-hang') {
        return { hang: true };
      }
      const reply = operation.reply(request);
      if (fault === 'partial') {
        const body = reply.body as { data?: unknown };
        return graphqlErrors([syntheticFailure()], body.data);
      }
      return reply;
    });
  }

  return {
    server,
    state,
    fault: (operation, ...queued) => {
      assert.ok(operation in operations, `No fake operation ${operation}`);
      faults.set(operation, [...(faults.get(operation) ?? []), ...queued]);
    },
    observe: (observer) => {
      observers.push(observer);
    },
    manga: (id) => {
      const manga = find(id);
      assert.ok(manga, `No fake manga ${id}`);
      return manga;
    },
    stamp: (id) => parseJson(find(id)?.meta[REQUEST_STAMP_KEY]),
    indexEntry: (requestId) =>
      parseJson(state.globalMeta.get(`${REQUEST_INDEX_PREFIX}${requestId}`)),
    operationNames: () =>
      server.requests.flatMap(({ operationName }) =>
        operationName ? [operationName] : []
      ),
    writes: () =>
      server.requests.filter(
        ({ operationName }) =>
          operationName !== undefined &&
          DISPATCH_WRITE_OPERATIONS.has(operationName)
      ),
    enqueuedIds: () =>
      server.operations('EnqueueChapters').flatMap((request) => idsOf(request)),
    close: () => server.close(),
  };
};

/**
 * The traffic rules every dispatch and release test keeps: only allowed
 * operations, never a library removal, never a manga refresh from the
 * source, and a category created by name alone.
 */
export const assertAllowedDispatchTraffic = (server: FakeSuwayomi): void => {
  for (const request of server.requests) {
    const name = request.operationName;
    assert.ok(
      name !== undefined && DISPATCH_ALLOWED_OPERATIONS.has(name),
      `Unexpected Suwayomi operation ${String(name)}`
    );
    if (name === 'SetInLibrary') {
      assert.strictEqual(request.variables.inLibrary, true);
    }
    if (name === 'FetchMangaAndChapters') {
      assert.strictEqual(request.variables.fetchManga, false);
    }
    if (name === 'CreateCategory') {
      assert.deepStrictEqual(Object.keys(request.variables), ['name']);
    }
  }
};

/** The settings of an instance served by `server`. */
export const dispatchInstanceFor = (
  server: FakeSuwayomi,
  id = 1,
  overrides: Partial<SuwayomiSettings> = {}
): SuwayomiSettings => {
  const url = new URL(server.url);
  return {
    id,
    name: `Suwayomi ${id}`,
    hostname: url.hostname,
    port: Number(url.port),
    useSsl: false,
    baseUrl: '',
    isDefault: id === 1,
    authMode: 'NONE',
    username: '',
    password: '',
    sourceAllowlist: [],
    preferredLanguages: [],
    scanlatorPreference: [],
    requireCbz: true,
    ...overrides,
  };
};

/** A client for `server` with short timeouts and an immediate read-back. */
export const dispatchClientFor = (
  server: FakeSuwayomi,
  timeouts: Partial<SuwayomiTimeouts> = {}
): SuwayomiAPI =>
  new SuwayomiAPI({
    url: server.url,
    auth: { mode: 'NONE' },
    timeouts: {
      query: 2_000,
      mutation: 2_000,
      queue: 2_000,
      source: 2_000,
      bytes: 2_000,
      ...timeouts,
    },
    readback: { attempts: 2, delayMs: 0 },
    warnInsecureAuthMode: false,
  });

export interface SeededDispatchRequest {
  request: MediaRequest;
  manifest: MangaRequestManifest;
  media: Media;
}

/**
 * An approved manga request with its manifest, BOUND by default. The request
 * is saved PENDING and approved without listeners, so seeding queues nothing.
 * Pass `media` to request a title that already has one.
 */
export const seedDispatchRequest = async ({
  anilistId = 9001,
  instanceId = 1,
  status = MediaRequestStatus.APPROVED,
  mediaStatus = MediaStatus.UNKNOWN,
  manifest = {},
  media: existing,
}: {
  anilistId?: number;
  instanceId?: number;
  status?: MediaRequestStatus;
  mediaStatus?: MediaStatus;
  manifest?: Partial<MangaRequestManifest>;
  media?: Media;
} = {}): Promise<SeededDispatchRequest> => {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const media =
    existing ??
    (await createMangaMedia(
      dataSource.manager,
      anilistId,
      MediaStatus.UNKNOWN
    ));
  const saved = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MANGA,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      serverId: instanceId,
    })
  );
  await dataSource
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status })
    .where({ id: saved.id })
    .callListeners(false)
    .execute();
  await dataSource
    .createQueryBuilder()
    .update(Media)
    .set({ status: mediaStatus })
    .where({ id: media.id })
    .callListeners(false)
    .execute();
  const created = await getRepository(MangaRequestManifest).save(
    new MangaRequestManifest({
      requestId: saved.id,
      anilistId,
      instanceId,
      ...DEFAULT_MANGA_REQUEST_SCOPE,
      bindingState: MangaRequestBindingState.BOUND,
      boundAt: new Date(),
      ...manifest,
    })
  );
  return {
    request: await loadDispatchRequest(saved.id),
    manifest: created,
    media,
  };
};

export const loadDispatchRequest = (id: number): Promise<MediaRequest> =>
  getRepository(MediaRequest).findOneOrFail({
    where: { id },
    relations: { media: true },
  });

/** A source binding of `anilistId` to `manga` on `instanceId`. */
export const seedDispatchBinding = (
  manga: Pick<FakeDispatchManga, 'id' | 'sourceId' | 'url' | 'inLibrary'>,
  {
    anilistId = 9001,
    instanceId = 1,
    ...overrides
  }: Partial<MangaSourceBinding> = {}
): Promise<MangaSourceBinding> =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId,
      sourceId: manga.sourceId,
      url: manga.url,
      urlHash: hashMangaSourceUrl(manga.url),
      anilistId,
      suwayomiMangaId: manga.id,
      title: `${FAKE_TITLE_PREFIX} ${manga.id}`,
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state: MangaBindingState.ACTIVE,
      inLibrary: manga.inLibrary,
      availability: MediaStatus.UNKNOWN,
      ...overrides,
    })
  );

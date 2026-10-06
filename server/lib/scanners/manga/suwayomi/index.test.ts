import AnilistAPI, {
  AnilistBadResponseError,
  AnilistGraphQLError,
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist';
import type { AnilistMangaSummary } from '@server/api/anilist/manga';
import {
  anilistRateLimiter,
  resetAnilistRateLimiterForTests,
} from '@server/api/anilist/rateLimiter';
import MangaDexAPI, { MangaDexRateLimitedError } from '@server/api/mangadex';
import { SUWAYOMI_TRACKER_IDS } from '@server/api/suwayomi';
import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaMatchCandidate from '@server/entity/MangaMatchCandidate';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { User } from '@server/entity/User';
import { getMangaContentPolicy } from '@server/lib/mangaCatalog';
import { createMangaMedia } from '@server/lib/mangaMedia';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import logger from '@server/logger';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  capabilitiesData,
  fakeLibraryManga,
  graphqlData,
  graphqlErrors,
  serveFakeLibrary,
  startFakeSuwayomi,
  syntheticFailure,
  type FakeAuthMode,
  type FakeLibrary,
  type FakeLibraryChapter,
  type FakeLibraryManga,
  type FakeReply,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import { Kind, OperationTypeNode, parse } from 'graphql';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';
import { mangaLibraryScanner } from './index';
import {
  MANGA_LOOKUP_SPACING_MS,
  setMangaLookupClockForTests,
} from './matching';

setupTestDb();

const USERNAME = 'fake-user';
const PASSWORD = randomUUID();
const READS = [
  'Capabilities',
  'LibraryChapterStates',
  'LibraryPage',
  'LibraryTrackRecords',
];
const TRACKING = capabilitiesData({
  mangaFields: ['id', 'title', 'trackRecords'],
});
const { aniList, myAnimeList } = SUWAYOMI_TRACKER_IDS;
const { AVAILABLE, PARTIALLY_AVAILABLE, UNKNOWN } = MediaStatus;
const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const servers: FakeSuwayomi[] = [];

const NO_CHANGES = {
  bindingsCreated: 0,
  bindingsUpdated: 0,
  bindingsReactivated: 0,
  bindingsOrphaned: 0,
  candidatesCreated: 0,
  candidatesUpdated: 0,
  candidatesDeleted: 0,
  mediaCreated: 0,
  mediaUpdated: 0,
  warnings: {},
};

/** A library manga whose AniList tracker record names `anilistId`. */
const tracked = (
  id: number,
  anilistId: number,
  overrides: Partial<FakeLibraryManga> = {}
) =>
  fakeLibraryManga(id, {
    trackRecords: [{ trackerId: aniList, remoteId: String(anilistId) }],
    ...overrides,
  });

const chapters = (...states: [number, boolean][]): FakeLibraryChapter[] =>
  states.map(([chapterNumber, isDownloaded]) => ({
    chapterNumber,
    isDownloaded,
  }));

/** A raw LibraryPage node, for replies the shared fake cannot script. */
const node = ({ id, sourceId, url, title }: FakeLibraryManga) => ({
  id,
  sourceId,
  url,
  title,
  downloadCount: 1,
  hasDuplicateChapters: false,
  chapters: { totalCount: 1 },
});

const page = (
  nodes: unknown[],
  totalCount: number,
  endCursor: string | null = null
): FakeReply =>
  graphqlData({
    mangas: {
      totalCount,
      pageInfo: { hasNextPage: endCursor !== null, endCursor },
      nodes,
    },
  });

/**
 * Lists `library` in one page of raw nodes. Another writer runs `write` while
 * the first listing is taken.
 */
const listWhile = (
  server: FakeSuwayomi,
  library: FakeLibrary,
  write: () => Promise<unknown>
) => {
  let pending = true;
  server.onOperation('LibraryPage', async () => {
    if (pending) {
      pending = false;
      await write();
    }
    return page(library.mangas.map(node), library.mangas.length);
  });
};

/** A resolver's binding of `manga` that no listing has contained yet. */
const unlistedBinding = (manga: FakeLibraryManga, anilistId: number) => ({
  instanceId: 1,
  sourceId: manga.sourceId,
  url: manga.url,
  urlHash: hashMangaSourceUrl(manga.url),
  anilistId,
  suwayomiMangaId: manga.id,
  title: manga.title,
  confidence: MangaBindingConfidence.HIGH,
  matchedBy: 'title',
  origin: 'resolver',
  state: MangaBindingState.ACTIVE,
  inLibrary: false,
});

const start = async (library: FakeLibrary, mode: FakeAuthMode = 'NONE') => {
  const server = await startFakeSuwayomi({
    mode,
    username: USERNAME,
    password: PASSWORD,
  });
  serveFakeLibrary(server, library);
  servers.push(server);
  return server;
};

const instanceFor = (
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
    username: USERNAME,
    password: PASSWORD,
    sourceAllowlist: [],
    preferredLanguages: [],
    scanlatorPreference: [],
    requireCbz: true,
    ...overrides,
  };
};

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

const scan = async () => {
  await mangaLibraryScanner.run();
  return mangaLibraryScanner.status().counts;
};

const bindings = () =>
  getRepository(MangaSourceBinding).find({ order: { id: 'ASC' } });

const candidates = () =>
  getRepository(MangaMatchCandidate).find({ order: { id: 'ASC' } });

const bound = async () =>
  (await bindings()).map((binding) => [
    binding.instanceId,
    binding.suwayomiMangaId,
    binding.anilistId,
    binding.state,
    binding.availability,
  ]);

const mediaStatus = async (anilistId: number) => {
  const identifier = await getRepository(MediaIdentifier).findOne({
    where: {
      provider: MediaIdentifierProvider.ANILIST,
      value: String(anilistId),
    },
    relations: { media: true },
  });
  return identifier?.media.status;
};

const captureLogs = () => {
  const logs: unknown[] = [];
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    mock.method(logger, level, (...args: unknown[]) => {
      logs.push(args);
      return logger;
    });
  }
  return logs;
};

/** Every Suwayomi request was a query. */
const assertReadsOnly = (server: FakeSuwayomi) => {
  for (const request of server.requests) {
    assert.ok(request.query);
    for (const definition of parse(request.query).definitions) {
      assert.equal(definition.kind, Kind.OPERATION_DEFINITION);
      assert.equal(definition.operation, OperationTypeNode.QUERY);
    }
  }
};

/** An obviously fake MangaDex UUID. */
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A library manga whose MyAnimeList tracker record names `malId`. */
const malTracked = (
  id: number,
  malId: number,
  overrides: Partial<FakeLibraryManga> = {}
) =>
  fakeLibraryManga(id, {
    trackRecords: [{ trackerId: myAnimeList, remoteId: String(malId) }],
    ...overrides,
  });

const anilistManga = (
  id: number,
  romaji: string,
  synonyms: string[] = [],
  extra: Partial<AnilistMangaSummary> = {}
): AnilistMangaSummary => ({
  id,
  titles: { romaji },
  synonyms,
  isAdult: false,
  genres: [],
  ...extra,
});

type MalPage = { hasNextPage: boolean; links: [number, number][] };

/** No lookup leaves a test; by default every lookup finds nothing. */
const stubLookups = () => ({
  mal: mock.method(AnilistAPI.prototype, 'getMangaIdsByMalIds', async () => ({
    hasNextPage: false,
    links: [],
  })),
  mangadex: mock.method(
    MangaDexAPI.prototype,
    'getAniListLinks',
    async (uuids: readonly string[]) =>
      new Map(uuids.map((value) => [value, null]))
  ),
  titles: mock.method(
    AnilistAPI.prototype,
    'searchMangaTitles',
    async () => []
  ),
});
let lookups: ReturnType<typeof stubLookups>;

/** Scripts the MAL lookup: `pages[n]` answers page n + 1 of every batch. */
const malPages = (...pages: MalPage[]) =>
  lookups.mal.mock.mockImplementation(
    async (malIds: readonly number[], page: number) => {
      const reply = pages[page - 1];
      return {
        hasNextPage: reply.hasNextPage,
        links: reply.links
          .filter(([malId]) => malIds.includes(malId))
          .map(([malId, anilistId]) => ({ anilistId, malId })),
      };
    }
  );

const titleSearches = () =>
  lookups.titles.mock.calls.map(({ arguments: [search] }) => search);

const progress = async () =>
  (await candidates()).map((candidate) => [
    candidate.suwayomiMangaId,
    candidate.malId,
    candidate.malCheckedAt !== null,
    candidate.mangadexCheckedAt !== null,
    candidate.titleCheckedAt !== null,
  ]);

const proposals = async () =>
  (await candidates()).map((candidate) => [
    candidate.suwayomiMangaId,
    candidate.proposedAnilistId,
    candidate.proposalConfidence,
    candidate.proposalScore,
  ]);

/** Per instance: the MAL, MangaDex and title lookups a stopped step left. */
const deferredLookups = (logs: unknown[]) =>
  (logs as [string, Record<string, unknown>][])
    .filter(
      ([message]) => message === 'Manga library lookups left for a later run'
    )
    .map(([, meta]) => [meta.instanceId, meta.mal, meta.mangadex, meta.title]);

/** The handled and listed titles of each progress line. */
const progressLines = (logs: unknown[]) =>
  (logs as [string, Record<string, unknown>][])
    .filter(([message]) => message === 'Manga library scan progress')
    .map(([, meta]) => [meta.handled, meta.listed]);

/** The counts and totals of the run's completion line. */
const completion = (logs: unknown[]) => {
  const line = (logs as [string, Record<string, unknown>][]).find(
    ([message]) => message === 'Manga library scan complete'
  );
  return (
    line &&
    Object.fromEntries(
      Object.entries(line[1]).filter(([key]) => key !== 'label')
    )
  );
};

/**
 * The lookup clock is fake: a wait passes at once and is recorded, unless
 * a test holds it.
 */
let waits: number[] = [];
let fakeNow = 0;
let holdWait: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
const fakeClock = {
  now: () => fakeNow,
  sleep: async (ms: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    waits.push(ms);
    if (holdWait && signal) await holdWait(ms, signal);
    fakeNow += ms;
  },
};

/** The waits between lookups, without the spacing of 3 seconds. */
const refusalWaits = () => waits.filter((ms) => ms !== MANGA_LOOKUP_SPACING_MS);

/**
 * What an AniList client does before each request: reserve a start in the
 * process-wide budget, queueing at most as long as the client allows.
 */
const reserveAnilistStart = (client: AnilistAPI, signal?: AbortSignal) =>
  anilistRateLimiter.acquire(
    (client as unknown as { maxRateLimitWaitMs: number }).maxRateLimitWaitMs,
    signal
  );

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  configure();
  waits = [];
  fakeNow = Date.UTC(2030, 0, 1);
  holdWait = undefined;
  setMangaLookupClockForTests(fakeClock);
  resetAnilistRateLimiterForTests(fakeClock);
  lookups = stubLookups();
});

afterEach(async () => {
  mock.restoreAll();
  setMangaLookupClockForTests();
  resetAnilistRateLimiterForTests();
  settings.main.enabledMediaCategories = categories;
  configure();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('manga library scan: Suwayomi traffic', () => {
  it('sends only reads, and only to the configured server', async () => {
    const server = await start(
      {
        mangas: [
          tracked(1, 101, { chapterCount: 2, downloadCount: 2 }),
          fakeLibraryManga(2, { chapterCount: 1 }),
          tracked(3, 103, {
            hasDuplicateChapters: true,
            chapters: chapters([1, true], [1, false], [2, false]),
          }),
        ],
      },
      'BASIC_AUTH'
    );
    configure(instanceFor(server, 1, { authMode: 'BASIC_AUTH' }));
    const connect = mock.method(net.Socket.prototype, 'connect');

    await scan();

    // Sockets come from the HTTP agent (an options object, or the array Node
    // normalizes it to) and from the database driver (port, then host). The
    // database's own connections are not Suwayomi traffic.
    const target = (args: unknown[]) => {
      const [first, second] = args;
      if (
        typeof first === 'number' ||
        (typeof first === 'string' && /^\d+$/.test(first))
      ) {
        return `${typeof second === 'string' ? second : 'localhost'}:${first}`;
      }
      const options = (Array.isArray(first) ? first[0] : first) as {
        host?: string;
        port?: number | string;
      };
      return `${options.host}:${options.port}`;
    };
    const databaseOptions = dataSource.options;
    const databaseUrl =
      databaseOptions.type === 'postgres' && databaseOptions.url
        ? new URL(databaseOptions.url)
        : undefined;
    const database =
      databaseOptions.type !== 'postgres'
        ? undefined
        : databaseUrl
          ? `${databaseUrl.hostname}:${databaseUrl.port || 5432}`
          : `${databaseOptions.host ?? 'localhost'}:${databaseOptions.port ?? 5432}`;
    const targets = connect.mock.calls
      .map(({ arguments: args }) => target(args))
      .filter((address) => address !== database);
    assert.ok(targets.length > 0);
    assert.deepEqual(new Set(targets), new Set([new URL(server.url).host]));
    assert.deepEqual(
      [...new Set(server.requests.map((r) => r.operationName))].sort(),
      READS
    );
    for (const request of server.requests) {
      assert.ok(request.query);
      for (const definition of parse(request.query).definitions) {
        assert.equal(definition.kind, Kind.OPERATION_DEFINITION);
        assert.equal(definition.operation, OperationTypeNode.QUERY);
      }
    }
    assert.equal(await mediaStatus(101), AVAILABLE);
  });

  it('adds only the token operations when the server wants a login', async () => {
    const server = await start(
      { mangas: [tracked(1, 101, { chapterCount: 1, downloadCount: 1 })] },
      'UI_LOGIN'
    );
    configure(instanceFor(server, 1, { authMode: 'UI_LOGIN' }));

    await scan();

    assert.ok(server.logins >= 1);
    for (const request of server.requests) {
      assert.ok(request.query);
      const writes = parse(request.query).definitions.some(
        (definition) =>
          definition.kind === Kind.OPERATION_DEFINITION &&
          definition.operation !== OperationTypeNode.QUERY
      );
      const allowed = writes ? ['Login', 'Refresh'] : READS;
      assert.ok(allowed.includes(request.operationName ?? ''));
    }
    assert.equal(await mediaStatus(101), AVAILABLE);
  });

  it('logs codes, counts and IDs, never titles, URLs or upstream text', async () => {
    const failing = await start({ mangas: [tracked(1, 101)] });
    failing.onOperation(
      'LibraryPage',
      graphqlErrors([syntheticFailure('Fake Library Title 1 /fake-library/1')])
    );
    const healthy = await start({
      mangas: [tracked(1, 102, { chapterCount: 1 }), fakeLibraryManga(2)],
    });
    healthy.onOperation(
      'LibraryTrackRecords',
      graphqlErrors([syntheticFailure()])
    );
    configure(
      instanceFor(failing, 1, { authMode: 'BASIC_AUTH' }),
      instanceFor(healthy, 2)
    );
    const logs = captureLogs();

    const counts = await scan();

    assert.deepEqual(counts.warnings, {
      INSTANCE_FAILED: 1,
      TRACK_RECORDS_FAILED: 2,
    });
    const text = inspect(logs, { depth: 8 });
    assert.match(text, /UPSTREAM_ERROR/);
    for (const forbidden of [
      'Fake Library Title',
      '/fake-library/',
      PASSWORD,
      'FakeFailureException',
      'synthetic failure',
    ]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });
});

describe('manga library scan: matching', () => {
  it('binds by AniList tracker record and records what is downloaded', async () => {
    const server = await start({
      mangas: [
        tracked(1, 101, { chapterCount: 3, downloadCount: 3 }),
        tracked(2, 102, { chapterCount: 3, downloadCount: 2 }),
        tracked(3, 103, { chapterCount: 3 }),
        fakeLibraryManga(4, { chapterCount: 2, downloadCount: 2 }),
      ],
    });
    // The allowlist limits what may be downloaded, not what the scan reads.
    configure(
      instanceFor(server, 1, { sourceAllowlist: ['4000000000000000001'] })
    );

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsCreated: 3,
      candidatesCreated: 1,
      mediaCreated: 2,
    });
    const [first] = await bindings();
    assert.equal(first.sourceId, '0');
    assert.equal(first.url, '/fake-library/1');
    assert.equal(first.urlHash, hashMangaSourceUrl('/fake-library/1'));
    assert.equal(first.confidence, MangaBindingConfidence.TRACKER_LINK);
    assert.equal(first.matchedBy, 'anilist-tracker');
    assert.equal(first.origin, 'library-scan');
    assert.equal(first.inLibrary, true);
    assert.equal(first.title, 'Fake Library Title 1');
    assert.deepEqual(
      (await bindings()).map((binding) => [
        binding.suwayomiMangaId,
        binding.anilistId,
        binding.chapterCount,
        binding.downloadCount,
        binding.availability,
      ]),
      [
        [1, 101, 3, 3, AVAILABLE],
        [2, 102, 3, 2, PARTIALLY_AVAILABLE],
        [3, 103, 3, 0, UNKNOWN],
      ]
    );
    assert.deepEqual(
      (await candidates()).map((candidate) => [
        candidate.instanceId,
        candidate.suwayomiMangaId,
        candidate.sourceId,
        candidate.url,
        candidate.title,
      ]),
      [[1, 4, '0', '/fake-library/4', 'Fake Library Title 4']]
    );
    assert.equal(await mediaStatus(101), AVAILABLE);
    assert.equal(await mediaStatus(102), PARTIALLY_AVAILABLE);
    // Marker only: in the library with nothing downloaded makes no media.
    assert.equal(await mediaStatus(103), undefined);
    const media = await getRepository(Media).find();
    assert.ok(media.every(({ mediaType }) => mediaType === MediaType.MANGA));
    assert.ok(media.every(({ mediaAddedAt }) => mediaAddedAt instanceof Date));
  });

  it('changes nothing when it scans an unchanged library again', async () => {
    const server = await start({
      mangas: [
        tracked(1, 101, { chapterCount: 2, downloadCount: 2 }),
        tracked(2, 102, { chapterCount: 2, downloadCount: 1 }),
        tracked(3, 103, {
          hasDuplicateChapters: true,
          chapters: chapters([1, true], [1, false], [2, true]),
        }),
        fakeLibraryManga(4),
      ],
    });
    configure(instanceFor(server));
    await scan();
    const rows = async () =>
      JSON.stringify([
        await bindings(),
        await candidates(),
        await getRepository(Media).find({ order: { id: 'ASC' } }),
        await getRepository(MediaIdentifier).find({ order: { id: 'ASC' } }),
      ]);
    const before = await rows();

    assert.deepEqual(await scan(), NO_CHANGES);
    assert.equal(await rows(), before);
    assert.equal(await mediaStatus(103), AVAILABLE);
  });

  it('leaves MAL-only, conflicting and malformed tracker records unmatched', async () => {
    const server = await start({
      mangas: [
        fakeLibraryManga(1, {
          trackRecords: [{ trackerId: myAnimeList, remoteId: '55' }],
        }),
        fakeLibraryManga(2, {
          trackRecords: [
            { trackerId: aniList, remoteId: '101' },
            { trackerId: aniList, remoteId: '102' },
          ],
        }),
        fakeLibraryManga(3, {
          trackRecords: ['0', '01', '2147483648'].map((remoteId) => ({
            trackerId: aniList,
            remoteId,
          })),
        }),
        fakeLibraryManga(4, {
          trackRecords: [
            { trackerId: aniList, remoteId: '104' },
            { trackerId: aniList, remoteId: '104' },
            { trackerId: myAnimeList, remoteId: '56' },
          ],
        }),
      ],
    });
    configure(instanceFor(server));

    const counts = await scan();

    assert.deepEqual(await bound(), [
      [1, 4, 104, MangaBindingState.ACTIVE, UNKNOWN],
    ]);
    assert.deepEqual(
      (await candidates()).map(({ suwayomiMangaId }) => suwayomiMangaId),
      [1, 2, 3]
    );
    assert.deepEqual(counts.warnings, { AMBIGUOUS_TRACKER_LINK: 1 });
  });

  it('never binds a rejected pair again and keeps an existing binding', async () => {
    const library = {
      mangas: [
        tracked(1, 101, { chapterCount: 1, downloadCount: 1 }),
        tracked(2, 102, { chapterCount: 1, downloadCount: 1 }),
      ],
    };
    const server = await start(library);
    configure(instanceFor(server));
    const stored = (
      id: number,
      anilistId: number,
      state: MangaBindingState
    ) => {
      const url = `/fake-library/${id}`;
      return {
        instanceId: 1,
        sourceId: '0',
        url,
        urlHash: hashMangaSourceUrl(url),
        anilistId,
        confidence: MangaBindingConfidence.MANUAL,
        matchedBy: 'manual',
        origin: 'review',
        state,
        inLibrary: state === MangaBindingState.ACTIVE,
      };
    };
    await getRepository(MangaSourceBinding).insert([
      stored(1, 101, MangaBindingState.REJECTED),
      stored(2, 500, MangaBindingState.ACTIVE),
    ]);

    await scan();

    assert.deepEqual(await bound(), [
      [1, null, 101, MangaBindingState.REJECTED, UNKNOWN],
      [1, 2, 500, MangaBindingState.ACTIVE, AVAILABLE],
    ]);
    assert.deepEqual(
      (await candidates()).map(({ suwayomiMangaId }) => suwayomiMangaId),
      [1]
    );
    assert.deepEqual(
      server
        .operations('LibraryTrackRecords')
        .map((request) => request.variables.ids),
      [[1]]
    );
    assert.equal(await mediaStatus(500), AVAILABLE);
    assert.equal(await mediaStatus(102), undefined);

    // A different AniList ID is a new pair; the rejected one stays refused.
    library.mangas[0] = tracked(1, 103, { chapterCount: 1, downloadCount: 1 });
    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsCreated: 1,
      candidatesDeleted: 1,
      mediaCreated: 1,
    });
    assert.deepEqual(await bound(), [
      [1, null, 101, MangaBindingState.REJECTED, UNKNOWN],
      [1, 2, 500, MangaBindingState.ACTIVE, AVAILABLE],
      [1, 1, 103, MangaBindingState.ACTIVE, AVAILABLE],
    ]);
    assert.deepEqual(await candidates(), []);
  });

  it('files every unbound item for review without track records', async () => {
    const server = await start({
      mangas: [tracked(1, 101, { chapterCount: 1, downloadCount: 1 })],
    });
    server.onOperation('Capabilities', capabilitiesData());
    configure(instanceFor(server));

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      candidatesCreated: 1,
      warnings: { NO_TRACK_RECORDS: 1 },
    });
    assert.deepEqual(await bindings(), []);
    assert.deepEqual(server.operations('LibraryTrackRecords'), []);
  });

  it('changes nothing about an item whose tracker read failed', async () => {
    const library = {
      mangas: [
        tracked(2, 102, { chapterCount: 1, downloadCount: 1 }),
        fakeLibraryManga(3),
      ],
    };
    const server = await start(library);
    configure(instanceFor(server));
    await scan();
    library.mangas = [
      tracked(1, 101, { chapterCount: 1, downloadCount: 1 }),
      tracked(2, 102, { chapterCount: 2, downloadCount: 1 }),
      fakeLibraryManga(3, { title: 'Fake Library Title 3b' }),
    ];
    server.onOperation(
      'LibraryTrackRecords',
      graphqlErrors([syntheticFailure()])
    );

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsUpdated: 1,
      mediaUpdated: 1,
      warnings: { TRACK_RECORDS_FAILED: 2 },
    });
    assert.deepEqual(await bound(), [
      [1, 2, 102, MangaBindingState.ACTIVE, PARTIALLY_AVAILABLE],
    ]);
    assert.deepEqual(
      (await candidates()).map(({ suwayomiMangaId, title }) => [
        suwayomiMangaId,
        title,
      ]),
      [[3, 'Fake Library Title 3']]
    );

    serveFakeLibrary(server, library);
    await scan();
    assert.deepEqual((await bound()).slice(1), [
      [1, 1, 101, MangaBindingState.ACTIVE, AVAILABLE],
    ]);
  });
});

describe('manga library scan: lookups', () => {
  const rejectedRow = (id: number, anilistId: number, url?: string) => {
    const itemUrl = url ?? `/fake-library/${id}`;
    return {
      instanceId: 1,
      sourceId: '0',
      url: itemUrl,
      urlHash: hashMangaSourceUrl(itemUrl),
      anilistId,
      confidence: MangaBindingConfidence.HIGH,
      matchedBy: 'title',
      origin: 'admin',
      state: MangaBindingState.REJECTED,
      inLibrary: false,
    };
  };
  const exactLinks = async () =>
    (await bindings()).map((binding) => [
      binding.suwayomiMangaId,
      binding.anilistId,
      binding.confidence,
      binding.matchedBy,
      binding.origin,
    ]);
  /** The bindings the scan made, without the admin's rejections. */
  const scanLinks = async () =>
    (await exactLinks()).filter(([, , , , origin]) => origin !== 'admin');

  it('reads every page of a MAL lookup before it binds an exact link', async () => {
    const server = await start({
      mangas: [
        malTracked(1, 55, { chapterCount: 1, downloadCount: 1 }),
        malTracked(2, 56),
        malTracked(3, 57),
        malTracked(4, 58, { url: `/manga/${uuid(4)}` }),
      ],
    });
    configure(instanceFor(server));
    // 56 and 58 each name two AniList manga, one on each page.
    malPages(
      {
        hasNextPage: true,
        links: [
          [55, 201],
          [56, 202],
          [58, 204],
        ],
      },
      {
        hasNextPage: false,
        links: [
          [56, 203],
          [58, 205],
        ],
      }
    );
    lookups.mangadex.mock.mockImplementation(
      async () => new Map([[uuid(4), 301]])
    );

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsCreated: 2,
      candidatesCreated: 2,
      mediaCreated: 1,
      warnings: { AMBIGUOUS_MAL_LINK: 2 },
    });
    assert.deepEqual(
      lookups.mal.mock.calls.map(({ arguments: [malIds, page] }) => [
        malIds,
        page,
      ]),
      [
        [[55, 56, 57, 58], 1],
        [[55, 56, 57, 58], 2],
      ]
    );
    // An ambiguous MAL ID binds nothing, but MangaDex may still link it.
    assert.deepEqual(
      lookups.mangadex.mock.calls.map(({ arguments: [uuids] }) => uuids),
      [[uuid(4)]]
    );
    assert.deepEqual(await exactLinks(), [
      [
        1,
        201,
        MangaBindingConfidence.TRACKER_LINK,
        'mal-tracker',
        'library-scan',
      ],
      [
        4,
        301,
        MangaBindingConfidence.EXACT_LINK,
        'mangadex-link',
        'library-scan',
      ],
    ]);
    assert.deepEqual(await progress(), [
      [2, 56, true, false, true],
      [3, 57, true, false, true],
    ]);
    assert.equal(await mediaStatus(201), AVAILABLE);
    assertReadsOnly(server);
  });

  for (const [name, failure, cause, calls] of [
    // AniList refuses the page three times, each after the wait it asked.
    ['rate-limited', () => new AnilistRateLimitedError(60), 'RATE_LIMITED', 5],
    ['malformed', () => new AnilistBadResponseError(), 'BAD_RESPONSE', 3],
  ] as const) {
    it(`leaves a batch unchecked after a ${name} page`, async () => {
      // 51 MAL IDs make two batches: the first is read in full, the second
      // fails on its second page.
      const server = await start({
        mangas: Array.from({ length: 51 }, (_, index) =>
          malTracked(index + 1, 1001 + index)
        ),
      });
      configure(instanceFor(server));
      lookups.mal.mock.mockImplementation(
        async (malIds: readonly number[], page: number) => {
          if (malIds.length === 50) return { hasNextPage: false, links: [] };
          if (page === 1) {
            return {
              hasNextPage: true,
              links: [{ anilistId: 999, malId: 1051 }],
            };
          }
          throw failure();
        }
      );
      const logs = captureLogs();

      const counts = await scan();

      assert.deepEqual(counts, {
        ...NO_CHANGES,
        candidatesCreated: 51,
        warnings: { MAL_LOOKUP_FAILED: 1 },
      });
      assert.equal(lookups.mal.mock.callCount(), calls);
      assert.deepEqual(
        refusalWaits(),
        name === 'rate-limited' ? [60_000, 60_000] : []
      );
      const rows = await progress();
      assert.equal(rows.filter(([, , malChecked]) => malChecked).length, 50);
      assert.deepEqual(rows[50], [51, null, false, false, false]);
      // Step 3 failed for item 51 alone; the title step still searched
      // every other title.
      assert.equal(titleSearches().length, 50);
      assert.equal(titleSearches().includes('Fake Library Title 51'), false);
      assert.match(inspect(logs, { depth: 8 }), new RegExp(cause));
    });
  }

  it('fails a MAL lookup whose pages never end, and searches no title', async () => {
    const server = await start({ mangas: [malTracked(1, 55)] });
    configure(instanceFor(server));
    lookups.mal.mock.mockImplementation(async () => ({
      hasNextPage: true,
      links: [],
    }));
    const logs = captureLogs();

    const counts = await scan();

    assert.equal(lookups.mal.mock.callCount(), 10);
    assert.deepEqual(counts, {
      ...NO_CHANGES,
      candidatesCreated: 1,
      warnings: { MAL_LOOKUP_FAILED: 1 },
    });
    assert.deepEqual(await progress(), [[1, null, false, false, false]]);
    assert.deepEqual(titleSearches(), []);
    assert.match(inspect(logs, { depth: 8 }), /BAD_RESPONSE/);
  });

  it('sends MangaDex only the UUID of a /manga/<uuid> URL', async () => {
    const server = await start({
      mangas: [
        fakeLibraryManga(1, {
          url: `/manga/${uuid(1)}`,
          chapterCount: 1,
          downloadCount: 1,
        }),
        fakeLibraryManga(2, { url: `/manga/${uuid(2).toUpperCase()}` }),
        fakeLibraryManga(3, { url: `/manga/${uuid(3)}` }),
        fakeLibraryManga(4, { url: `/manga/${uuid(4)}/chapters` }),
        fakeLibraryManga(5, { url: `manga/${uuid(5)}` }),
        fakeLibraryManga(6, { url: `/title/${uuid(6)}` }),
        fakeLibraryManga(7, {
          url: '/manga/00000000-0000-4000-8000-00000000000z',
        }),
      ],
    });
    configure(instanceFor(server));
    const links = new Map([
      [uuid(1), 301],
      [uuid(2), 302],
    ]);
    lookups.mangadex.mock.mockImplementation(
      async (uuids: readonly string[]) =>
        new Map(uuids.map((value) => [value, links.get(value) ?? null]))
    );

    const counts = await scan();

    assert.deepEqual(
      lookups.mangadex.mock.calls.map(({ arguments: [uuids] }) => uuids),
      [[uuid(1), uuid(2), uuid(3)]]
    );
    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsCreated: 2,
      candidatesCreated: 5,
      mediaCreated: 1,
    });
    assert.deepEqual(await exactLinks(), [
      [
        1,
        301,
        MangaBindingConfidence.EXACT_LINK,
        'mangadex-link',
        'library-scan',
      ],
      [
        2,
        302,
        MangaBindingConfidence.EXACT_LINK,
        'mangadex-link',
        'library-scan',
      ],
    ]);
    // An unknown UUID is a concluded check; other shapes are never sent.
    assert.deepEqual(
      (await progress()).map(([id, , , mangadexChecked]) => [
        id,
        mangadexChecked,
      ]),
      [
        [3, true],
        [4, false],
        [5, false],
        [6, false],
        [7, false],
      ]
    );
    assert.equal(await mediaStatus(301), AVAILABLE);
    assertReadsOnly(server);
  });

  it('leaves MangaDex items unchecked during a cooldown of over 15 minutes', async () => {
    const server = await start({
      mangas: [
        fakeLibraryManga(1, { url: `/manga/${uuid(1)}` }),
        fakeLibraryManga(2, { url: `/manga/${uuid(2)}` }),
        fakeLibraryManga(3),
      ],
    });
    configure(instanceFor(server));
    lookups.mangadex.mock.mockImplementation(async () => {
      throw new MangaDexRateLimitedError(3_600, true);
    });
    const logs = captureLogs();

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      candidatesCreated: 3,
      warnings: { MANGADEX_LOOKUP_FAILED: 2 },
    });
    assert.equal(lookups.mangadex.mock.callCount(), 1);
    assert.deepEqual(refusalWaits(), []);
    assert.deepEqual(await progress(), [
      [1, null, false, false, false],
      [2, null, false, false, false],
      [3, null, false, false, true],
    ]);
    assert.deepEqual(titleSearches(), ['Fake Library Title 3']);
    const text = inspect(logs, { depth: 8 });
    assert.match(text, /RATE_LIMITED/);
    for (const forbidden of [uuid(1), uuid(2), '/manga/', 'Fake Library']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });

  it('waits out a MangaDex rate limit and links the batch', async () => {
    const server = await start({
      mangas: [
        fakeLibraryManga(1, { url: `/manga/${uuid(1)}` }),
        fakeLibraryManga(2, { url: `/manga/${uuid(2)}` }),
      ],
    });
    configure(instanceFor(server));
    lookups.mangadex.mock.mockImplementationOnce(async () => {
      throw new MangaDexRateLimitedError(20, true);
    }, 0);
    lookups.mangadex.mock.mockImplementationOnce(async () => {
      throw new MangaDexRateLimitedError(5, false);
    }, 1);
    lookups.mangadex.mock.mockImplementation(
      async () =>
        new Map([
          [uuid(1), 301],
          [uuid(2), 302],
        ])
    );

    const counts = await scan();

    assert.deepEqual(counts, { ...NO_CHANGES, bindingsCreated: 2 });
    assert.equal(lookups.mangadex.mock.callCount(), 3);
    assert.deepEqual(refusalWaits(), [20_000, 5_000]);
    assert.deepEqual(
      (await exactLinks()).map(([id, anilistId]) => [id, anilistId]),
      [
        [1, 301],
        [2, 302],
      ]
    );
  });

  it('binds a confident title match and stores any other for review', async () => {
    const server = await start({
      mangas: [1, 2, 3, 4].map((id) =>
        fakeLibraryManga(id, { chapterCount: 1, downloadCount: 1 })
      ),
    });
    configure(instanceFor(server));
    const results: Record<string, AnilistMangaSummary[]> = {
      'Fake Library Title 1': [
        anilistManga(401, 'Fake Library Title 1'),
        anilistManga(402, 'Another Invented Name'),
      ],
      // Two results match exactly, so neither is a confident match.
      'Fake Library Title 2': [
        anilistManga(403, 'Invented Name', ['Fake Library Title 2']),
        anilistManga(404, 'Fake Library Title 2'),
      ],
      'Fake Library Title 3': [anilistManga(405, 'Unrelated Invented Name')],
    };
    lookups.titles.mock.mockImplementation(
      async (search: string) => results[search] ?? []
    );
    const { mangaIncludeAdult } = settings.main;
    settings.main.mangaIncludeAdult = true;
    const policy = getMangaContentPolicy();
    const counts = await scan().finally(() => {
      settings.main.mangaIncludeAdult = mangaIncludeAdult;
    });

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsCreated: 1,
      candidatesCreated: 3,
      mediaCreated: 1,
    });
    assert.deepEqual(await exactLinks(), [
      [1, 401, MangaBindingConfidence.HIGH, 'title', 'library-scan'],
    ]);
    assert.equal(await mediaStatus(401), AVAILABLE);
    const stored = await proposals();
    assert.deepEqual(stored[0], [2, 403, MangaBindingConfidence.MEDIUM, 1000]);
    // The best weak match is kept, ranked LOW.
    assert.deepEqual(stored[1].slice(0, 3), [
      3,
      405,
      MangaBindingConfidence.LOW,
    ]);
    assert.ok((stored[1][3] as number) < 750);
    assert.deepEqual(stored[2], [4, null, null, null]);
    assert.equal(policy.includeAdult, true);
    assert.deepEqual(
      lookups.titles.mock.calls.map(({ arguments: [search, used] }) => [
        search,
        used,
      ]),
      [1, 2, 3, 4].map((id) => [`Fake Library Title ${id}`, policy])
    );
  });

  it('drops a proposal once its title changes or an admin rejects it', async () => {
    const library = { mangas: [fakeLibraryManga(1), fakeLibraryManga(2)] };
    const server = await start(library);
    configure(instanceFor(server));
    // Close matches: neither is confident enough to bind.
    const results: Record<string, AnilistMangaSummary[]> = {
      'Fake Library Title 1': [anilistManga(401, 'Fake Library Title 1 Extra')],
      'Fake Library Title 2': [
        anilistManga(402, 'Fake Library Title 2 Extra'),
        anilistManga(403, 'Fake Library Title 2 Remake'),
      ],
    };
    const search = async (text: string) => results[text] ?? [];
    lookups.titles.mock.mockImplementation(search);
    await scan();
    const proposed = async () =>
      (await proposals()).map(([id, anilistId, confidence]) => [
        id,
        anilistId,
        confidence,
      ]);
    assert.deepEqual(await proposed(), [
      [1, 401, MangaBindingConfidence.MEDIUM],
      [2, 402, MangaBindingConfidence.MEDIUM],
    ]);

    // While AniList is down, both stale proposals still go.
    await getRepository(MangaSourceBinding).insert(rejectedRow(2, 402));
    library.mangas[0] = fakeLibraryManga(1, { title: 'Fake Library Title 1b' });
    lookups.titles.mock.mockImplementation(async () => {
      throw new AnilistOutageError();
    });
    const logs = captureLogs();

    const counts = await scan();

    assert.deepEqual(counts.warnings, { TITLE_SEARCH_FAILED: 1 });
    assert.equal(lookups.titles.mock.callCount(), 3);
    assert.deepEqual(deferredLookups(logs), [[1, undefined, undefined, 1]]);
    assert.deepEqual(await proposals(), [
      [1, null, null, null],
      [2, null, null, null],
    ]);
    assert.deepEqual(
      (await progress()).map(([, , , , titleChecked]) => titleChecked),
      [false, false]
    );

    // The next search proposes the best match that is still open.
    lookups.titles.mock.mockImplementation(search);
    await scan();
    assert.deepEqual(await proposed(), [
      [1, null, null],
      [2, 403, MangaBindingConfidence.LOW],
    ]);
    assert.deepEqual(
      (await bindings()).map(({ state }) => state),
      [MangaBindingState.REJECTED]
    );
  });

  it('never links or proposes a pair an admin rejected', async () => {
    const url = `/manga/${uuid(1)}`;
    const server = await start({
      mangas: [malTracked(1, 55, { url }), malTracked(2, 56)],
    });
    configure(instanceFor(server));
    await getRepository(MangaSourceBinding).insert([
      rejectedRow(1, 201, url),
      rejectedRow(2, 203),
    ]);
    malPages({
      hasNextPage: false,
      links: [
        [55, 201],
        [56, 203],
        [56, 204],
      ],
    });
    lookups.mangadex.mock.mockImplementation(
      async () => new Map([[uuid(1), 201]])
    );
    lookups.titles.mock.mockImplementation(async (search: string) =>
      search === 'Fake Library Title 1'
        ? [
            anilistManga(201, 'Fake Library Title 1'),
            anilistManga(202, 'Fake Library Title 1 Remake'),
          ]
        : [anilistManga(203, search)]
    );

    const counts = await scan();

    // 56 names two AniList manga, so rejecting one of them does not make
    // the other an exact link.
    assert.deepEqual(counts.warnings, { AMBIGUOUS_MAL_LINK: 1 });
    assert.deepEqual(await bound(), [
      [1, null, 201, MangaBindingState.REJECTED, UNKNOWN],
      [1, null, 203, MangaBindingState.REJECTED, UNKNOWN],
    ]);
    assert.deepEqual(await progress(), [
      [1, 55, true, true, true],
      [2, 56, true, false, true],
    ]);
    assert.deepEqual(
      (await proposals()).map(([id, anilistId]) => [id, anilistId]),
      [
        [1, 202],
        [2, null],
      ]
    );
  });

  it('only proposes a title when the tracker records disagree', async () => {
    const server = await start({
      mangas: [
        fakeLibraryManga(1, {
          url: `/manga/${uuid(1)}`,
          trackRecords: [
            { trackerId: myAnimeList, remoteId: '55' },
            { trackerId: myAnimeList, remoteId: '56' },
          ],
        }),
        fakeLibraryManga(2, {
          url: `/manga/${uuid(2)}`,
          trackRecords: [
            { trackerId: aniList, remoteId: '101' },
            { trackerId: aniList, remoteId: '102' },
            { trackerId: myAnimeList, remoteId: '57' },
          ],
        }),
      ],
    });
    configure(instanceFor(server));
    lookups.titles.mock.mockImplementation(async (search: string) => [
      anilistManga(401, search),
    ]);

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      candidatesCreated: 2,
      warnings: { AMBIGUOUS_TRACKER_LINK: 2 },
    });
    assert.equal(lookups.mal.mock.callCount(), 0);
    assert.equal(lookups.mangadex.mock.callCount(), 0);
    assert.deepEqual(await proposals(), [
      [1, 401, MangaBindingConfidence.HIGH, 1000],
      [2, 401, MangaBindingConfidence.HIGH, 1000],
    ]);
  });

  it('keeps a binding when its tracker records change and looks nothing up', async () => {
    const library = {
      mangas: [malTracked(1, 55, { chapterCount: 1, downloadCount: 1 })],
    };
    const server = await start(library);
    configure(instanceFor(server));
    malPages({
      hasNextPage: false,
      links: [
        [55, 201],
        [56, 202],
      ],
    });
    await scan();
    library.mangas[0] = fakeLibraryManga(1, {
      chapterCount: 1,
      downloadCount: 1,
      trackRecords: [
        { trackerId: aniList, remoteId: '203' },
        { trackerId: myAnimeList, remoteId: '56' },
      ],
    });
    lookups.mal.mock.resetCalls();

    assert.deepEqual(await scan(), NO_CHANGES);
    assert.deepEqual(await bound(), [
      [1, 1, 201, MangaBindingState.ACTIVE, AVAILABLE],
    ]);
    assert.equal(server.operations('LibraryTrackRecords').length, 1);
    assert.equal(lookups.mal.mock.callCount(), 0);
    assert.equal(lookups.mangadex.mock.callCount(), 0);
    assert.equal(lookups.titles.mock.callCount(), 0);
  });

  it('searches every due title in one run, never-checked first, and again after 30 days', async () => {
    const library = {
      mangas: Array.from({ length: 12 }, (_, index) =>
        fakeLibraryManga(index + 1)
      ),
    };
    const server = await start(library);
    configure(instanceFor(server));
    const titles = (...ids: number[]) =>
      ids.map((id) => `Fake Library Title ${id}`);

    await scan();
    assert.deepEqual(
      titleSearches(),
      titles(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)
    );

    lookups.titles.mock.resetCalls();
    await scan();
    assert.deepEqual(titleSearches(), []);

    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    for (const [suwayomiMangaId, days] of [
      [1, 31],
      [2, 29],
      [3, 40],
    ]) {
      await getRepository(MangaMatchCandidate).update(
        { suwayomiMangaId },
        { titleCheckedAt: daysAgo(days) }
      );
    }
    library.mangas.push(fakeLibraryManga(13));
    lookups.titles.mock.resetCalls();
    await scan();
    assert.deepEqual(titleSearches(), titles(13, 3, 1));
  });

  it('skips only a title whose own search failed', async () => {
    const server = await start({
      mangas: [fakeLibraryManga(1), fakeLibraryManga(2)],
    });
    configure(instanceFor(server));
    lookups.titles.mock.mockImplementationOnce(async () => {
      throw new AnilistGraphQLError('invented upstream text');
    });
    const logs = captureLogs();

    const counts = await scan();

    assert.deepEqual(counts.warnings, { TITLE_SEARCH_FAILED: 1 });
    assert.deepEqual(
      (await progress()).map(([id, , , , titleChecked]) => [id, titleChecked]),
      [
        [1, false],
        [2, true],
      ]
    );
    const text = inspect(logs, { depth: 8 });
    assert.match(text, /GRAPHQL_ERROR/);
    assert.equal(text.includes('invented upstream text'), false);
  });

  for (const step of ['mal', 'mangadex', 'titles'] as const) {
    it(`cancels the ${step} lookup in flight and writes nothing`, async () => {
      const server = await start({
        mangas: [malTracked(1, 55, { url: `/manga/${uuid(1)}` })],
      });
      configure(instanceFor(server));
      let reached!: () => void;
      const requested = new Promise<void>((resolve) => (reached = resolve));
      const lookup = lookups[step].mock as unknown as {
        mockImplementation: (
          fn: (...args: unknown[]) => Promise<never>
        ) => void;
      };
      lookup.mockImplementation((...args) => {
        const { signal } = args[args.length - 1] as { signal: AbortSignal };
        reached();
        return new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        );
      });

      const running = mangaLibraryScanner.run();
      await requested;
      mangaLibraryScanner.cancel();
      await running;

      assert.equal(mangaLibraryScanner.status().running, false);
      assert.deepEqual(mangaLibraryScanner.status().counts, NO_CHANGES);
      assert.deepEqual(await bindings(), []);
      assert.deepEqual(await candidates(), []);
    });
  }

  it('handles 60 unmatched titles in one run, at most 20 lookups a minute', async () => {
    const server = await start({
      mangas: Array.from({ length: 60 }, (_, index) =>
        fakeLibraryManga(index + 1)
      ),
    });
    configure(instanceFor(server));
    const starts: number[] = [];
    lookups.titles.mock.mockImplementation(async function (
      this: AnilistAPI,
      _search: string,
      _policy: unknown,
      options?: { signal?: AbortSignal }
    ) {
      await reserveAnilistStart(this, options?.signal);
      starts.push(fakeNow);
      return [];
    });
    const logs = captureLogs();

    const counts = await scan();

    assert.deepEqual(counts, { ...NO_CHANGES, candidatesCreated: 60 });
    assert.equal(starts.length, 60);
    assert.deepEqual(
      waits,
      Array.from({ length: 59 }, () => MANGA_LOOKUP_SPACING_MS)
    );
    for (const first of starts) {
      const minute = starts.filter(
        (other) => other >= first && other < first + 60_000
      );
      assert.ok(minute.length <= 20, String(minute.length));
    }
    assert.equal(
      (await progress()).filter(([, , , , titleChecked]) => titleChecked)
        .length,
      60
    );
    const { progress: handled, total } = mangaLibraryScanner.status();
    assert.deepEqual([handled, total], [60, 60]);
    assert.deepEqual(progressLines(logs), [[50, 60]]);
    assert.deepEqual(completion(logs), {
      ...counts,
      listed: 60,
      bound: {},
      proposed: 0,
      unmatched: 60,
    });
    assert.equal(inspect(logs, { depth: 8 }).includes('Fake Library'), false);
  });

  it('waits out rate limits and cooldowns mid-run and goes on', async () => {
    const server = await start({
      mangas: [malTracked(1, 55), fakeLibraryManga(2), fakeLibraryManga(3)],
    });
    configure(instanceFor(server));
    lookups.mal.mock.mockImplementationOnce(async () => {
      throw new AnilistRateLimitedError(45);
    });
    lookups.titles.mock.mockImplementation(async function (
      this: AnilistAPI,
      search: string,
      _policy: unknown,
      options?: { signal?: AbortSignal }
    ) {
      await reserveAnilistStart(this, options?.signal);
      // Meanwhile AniList refuses another request: a cooldown of 30 s.
      if (search === 'Fake Library Title 1') {
        anilistRateLimiter.noteRateLimited(30);
      }
      return [];
    });

    const counts = await scan();

    assert.deepEqual(counts, { ...NO_CHANGES, candidatesCreated: 3 });
    assert.equal(lookups.mal.mock.callCount(), 2);
    // The search for title 2 found the budget closed for 27 more seconds.
    assert.deepEqual(refusalWaits(), [45_000, 27_000]);
    assert.deepEqual(
      titleSearches(),
      [1, 2, 2, 3].map((id) => `Fake Library Title ${id}`)
    );
    assert.deepEqual(await progress(), [
      [1, 55, true, false, true],
      [2, null, false, false, true],
      [3, null, false, false, true],
    ]);
  });

  it('keeps its own AniList requests 3 s apart while others use the budget', async () => {
    const server = await start({
      mangas: [1, 2, 3].map((id) => fakeLibraryManga(id)),
    });
    configure(instanceFor(server));
    const starts: number[] = [];
    lookups.titles.mock.mockImplementation(async function (
      this: AnilistAPI,
      _search: string,
      _policy: unknown,
      options?: { signal?: AbortSignal }
    ) {
      await reserveAnilistStart(this, options?.signal);
      starts.push(fakeNow);
      // Other requests leave the budget closed for the next 5 s.
      if (starts.length === 1) anilistRateLimiter.noteRateLimited(5);
      return [];
    });
    const first = fakeNow;

    const counts = await scan();

    assert.deepEqual(counts, { ...NO_CHANGES, candidatesCreated: 3 });
    // The scan waits for the budget itself rather than queueing in it, so
    // the delayed request still starts a full spacing after the one before.
    assert.deepEqual(waits, [3_000, 2_000, 1_000, 3_000]);
    assert.deepEqual(
      starts.map((start) => start - first),
      [0, 6_000, 9_000]
    );
  });

  for (const [name, wait] of [
    ['a rate-limit wait', 600_000],
    ['the pause between lookups', MANGA_LOOKUP_SPACING_MS],
  ] as const) {
    it(`stops at once when cancelled during ${name} and writes nothing`, async () => {
      const server = await start({
        mangas: [fakeLibraryManga(1), fakeLibraryManga(2)],
      });
      configure(instanceFor(server));
      if (wait !== MANGA_LOOKUP_SPACING_MS) {
        lookups.titles.mock.mockImplementation(async () => {
          throw new AnilistRateLimitedError(wait / 1000);
        });
      }
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => (reached = resolve));
      holdWait = async (ms, signal) => {
        if (ms !== wait) return;
        reached();
        await new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        );
      };

      const running = mangaLibraryScanner.run();
      await waiting;
      mangaLibraryScanner.cancel();
      await running;

      assert.equal(lookups.titles.mock.callCount(), 1);
      const status = mangaLibraryScanner.status();
      assert.equal(status.running, false);
      // Only the title searched before the pause is handled.
      const handled = wait === MANGA_LOOKUP_SPACING_MS ? 1 : 0;
      assert.deepEqual([status.progress, status.total], [handled, 2]);
      assert.deepEqual(status.counts, NO_CHANGES);
      assert.deepEqual(await bindings(), []);
      assert.deepEqual(await candidates(), []);
    });
  }

  it('never binds a title match that the item argues against', async () => {
    const titled = (id: number, extra: Partial<AnilistMangaSummary> = {}) =>
      anilistManga(600 + id, `Fake Library Title ${id}`, [], extra);
    const server = await start({
      mangas: [
        fakeLibraryManga(1),
        fakeLibraryManga(2, {
          trackRecords: [
            { trackerId: aniList, remoteId: '101' },
            { trackerId: aniList, remoteId: '102' },
          ],
        }),
        tracked(3, 103),
        malTracked(4, 77),
        malTracked(5, 78),
        malTracked(6, 79),
        fakeLibraryManga(7),
      ],
    });
    configure(instanceFor(server));
    await getRepository(MangaSourceBinding).insert([
      rejectedRow(1, 601),
      rejectedRow(3, 103),
    ]);
    const results: Record<string, AnilistMangaSummary[]> = {
      // The rejected title is never proposed, so the weak match is.
      'Fake Library Title 1': [
        titled(1),
        anilistManga(611, 'Fake Library Title 1 Remake'),
      ],
      // Its own tracker records disagree.
      'Fake Library Title 2': [titled(2)],
      // Its AniList tracker names another title an admin rejected here.
      'Fake Library Title 3': [titled(3)],
      // Its MyAnimeList tracker names another title.
      'Fake Library Title 4': [titled(4, { idMal: 87 })],
      // The result does not say which MyAnimeList title it is.
      'Fake Library Title 5': [titled(5)],
      // The result is the title its MyAnimeList tracker names.
      'Fake Library Title 6': [titled(6, { idMal: 79 })],
      'Fake Library Title 7': [titled(7, { format: 'NOVEL' })],
    };
    lookups.titles.mock.mockImplementation(
      async (search: string) => results[search] ?? []
    );

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsCreated: 1,
      candidatesCreated: 6,
      warnings: { AMBIGUOUS_TRACKER_LINK: 1 },
    });
    assert.deepEqual(await scanLinks(), [
      [6, 606, MangaBindingConfidence.HIGH, 'title', 'library-scan'],
    ]);
    const { HIGH, MEDIUM, LOW } = MangaBindingConfidence;
    assert.deepEqual(
      (await proposals()).map(([id, anilistId, confidence]) => [
        id,
        anilistId,
        confidence,
      ]),
      [
        [1, 611, LOW],
        [2, 602, HIGH],
        [3, 603, HIGH],
        [4, 604, HIGH],
        [5, 605, HIGH],
        [7, 607, MEDIUM],
      ]
    );

    // A stored HIGH proposal of an item with tracker records waits for its
    // next search.
    lookups.titles.mock.resetCalls();
    assert.deepEqual(await scan(), {
      ...NO_CHANGES,
      warnings: { AMBIGUOUS_TRACKER_LINK: 1 },
    });
    assert.deepEqual(titleSearches(), []);
    assert.equal((await scanLinks()).length, 1);
  });

  describe('a stored proposal', () => {
    const checked = () => new Date(Date.now() - 24 * 60 * 60 * 1000);
    const storedProposal = (
      id: number,
      proposedAnilistId: number,
      proposalConfidence: MangaBindingConfidence,
      title = `Fake Library Title ${id}`
    ) => ({
      instanceId: 1,
      sourceId: '0',
      url: `/fake-library/${id}`,
      urlHash: hashMangaSourceUrl(`/fake-library/${id}`),
      suwayomiMangaId: id,
      title,
      proposedAnilistId,
      proposalConfidence,
      proposalScore: 1000,
      titleCheckedAt: checked(),
    });
    const { HIGH, MEDIUM } = MangaBindingConfidence;

    it('is searched again when it is HIGH, and the new result decides', async () => {
      const server = await start({
        mangas: [1, 2, 3, 4, 5, 6].map((id) =>
          fakeLibraryManga(id, { chapterCount: 1, downloadCount: 1 })
        ),
      });
      configure(instanceFor(server));
      await getRepository(MangaMatchCandidate).insert([
        storedProposal(1, 501, HIGH),
        storedProposal(2, 502, HIGH, 'An Older Invented Title'),
        storedProposal(3, 503, HIGH),
        storedProposal(4, 504, MEDIUM),
        storedProposal(6, 506, HIGH),
      ]);
      await getRepository(MangaSourceBinding).insert(rejectedRow(3, 503));
      const results: Record<string, AnilistMangaSummary[]> = {
        'Fake Library Title 1': [anilistManga(501, 'Fake Library Title 1')],
        // Two equal results make the new match MEDIUM.
        'Fake Library Title 6': [
          anilistManga(506, 'Fake Library Title 6'),
          anilistManga(516, 'Fake Library Title 6'),
        ],
      };
      lookups.titles.mock.mockImplementation(
        async (search: string) => results[search] ?? []
      );

      const counts = await scan();

      // A changed title or a rejection drops the proposal, so the item is
      // searched again like a stored HIGH proposal; a MEDIUM one waits.
      assert.deepEqual(
        titleSearches(),
        [2, 3, 5, 1, 6].map((id) => `Fake Library Title ${id}`)
      );
      assert.deepEqual(counts, {
        ...NO_CHANGES,
        bindingsCreated: 1,
        candidatesCreated: 1,
        candidatesUpdated: 3,
        candidatesDeleted: 1,
        mediaCreated: 1,
      });
      assert.deepEqual(await scanLinks(), [
        [1, 501, HIGH, 'title', 'library-scan'],
      ]);
      assert.equal(await mediaStatus(501), AVAILABLE);
      assert.deepEqual(
        (await proposals()).map(([id, anilistId, confidence]) => [
          id,
          anilistId,
          confidence,
        ]),
        [
          [2, null, null],
          [3, null, null],
          [4, 504, MEDIUM],
          [6, 506, MEDIUM],
          [5, null, null],
        ]
      );

      // The MEDIUM result waits for its next recheck.
      lookups.titles.mock.resetCalls();
      assert.deepEqual(await scan(), NO_CHANGES);
      assert.deepEqual(titleSearches(), []);
    });

    it('stays a proposal when the new search finds a novel', async () => {
      const { mangaIncludeNovels } = settings.main;
      settings.main.mangaIncludeNovels = true;
      try {
        const server = await start({ mangas: [fakeLibraryManga(1)] });
        configure(instanceFor(server));
        await getRepository(MangaMatchCandidate).insert(
          storedProposal(1, 501, HIGH)
        );
        lookups.titles.mock.mockImplementation(async () => [
          anilistManga(501, 'Fake Library Title 1', [], { format: 'NOVEL' }),
        ]);

        const counts = await scan();

        assert.deepEqual(titleSearches(), ['Fake Library Title 1']);
        assert.deepEqual(counts, { ...NO_CHANGES, candidatesUpdated: 1 });
        assert.deepEqual(await scanLinks(), []);
        assert.deepEqual(
          (await proposals()).map(([id, anilistId, confidence]) => [
            id,
            anilistId,
            confidence,
          ]),
          [[1, 501, MEDIUM]]
        );
      } finally {
        settings.main.mangaIncludeNovels = mangaIncludeNovels;
      }
    });
  });
});

describe('manga library scan: availability', () => {
  it('reads chapter states only for partial downloads with duplicates', async () => {
    const server = await start({
      mangas: [
        tracked(1, 101, {
          hasDuplicateChapters: true,
          chapters: chapters([1, true], [1, false], [2, true]),
        }),
        tracked(2, 102, {
          hasDuplicateChapters: true,
          chapterCount: 2_000,
          downloadCount: 1,
        }),
        tracked(3, 103, {
          hasDuplicateChapters: true,
          chapterCount: 2_000,
          downloadCount: 1,
        }),
        tracked(4, 104, {
          hasDuplicateChapters: true,
          chapterCount: 6_000,
          downloadCount: 1,
        }),
        tracked(5, 105, {
          hasDuplicateChapters: true,
          chapterCount: 2,
          downloadCount: 2,
        }),
        tracked(6, 106, { chapterCount: 2, downloadCount: 1 }),
        fakeLibraryManga(7, {
          hasDuplicateChapters: true,
          chapterCount: 2,
          downloadCount: 1,
        }),
      ],
    });
    configure(instanceFor(server));

    await scan();

    assert.deepEqual(
      server
        .operations('LibraryChapterStates')
        .map((request) => request.variables.ids),
      [[1, 2, 3], [4]]
    );
    assert.deepEqual(
      (await bindings()).map(({ anilistId, availability }) => [
        anilistId,
        availability,
      ]),
      [
        [101, AVAILABLE],
        [102, PARTIALLY_AVAILABLE],
        [103, PARTIALLY_AVAILABLE],
        [104, PARTIALLY_AVAILABLE],
        [105, AVAILABLE],
        [106, PARTIALLY_AVAILABLE],
      ]
    );
  });

  it('keeps the stored counts and status when chapter states cannot be read', async () => {
    const library = {
      mangas: [
        tracked(1, 101, {
          hasDuplicateChapters: true,
          chapters: chapters([1, true], [1, false], [2, true]),
        }),
        tracked(2, 102, {
          hasDuplicateChapters: true,
          chapters: chapters([1, true], [2, false]),
        }),
      ],
    };
    const server = await start(library);
    configure(instanceFor(server));
    await scan();
    const before = await bindings();
    // A new chapter that is not downloaded makes title 101 partial.
    library.mangas[0] = tracked(1, 101, {
      hasDuplicateChapters: true,
      chapters: chapters([1, true], [1, false], [2, true], [3, false]),
    });

    // One manga listed short, the other left out of the reply.
    server.onOperation(
      'LibraryChapterStates',
      graphqlData({
        mangas: {
          nodes: [
            {
              id: 1,
              chapters: {
                totalCount: 4,
                nodes: chapters([1, true], [1, false], [2, true]),
              },
            },
          ],
        },
      })
    );
    const short = await scan();
    // A failed batch.
    server.onOperation(
      'LibraryChapterStates',
      graphqlErrors([syntheticFailure()])
    );
    const failed = await scan();

    for (const counts of [short, failed]) {
      assert.deepEqual(counts, {
        ...NO_CHANGES,
        warnings: { CHAPTER_STATES_FAILED: 2 },
      });
    }
    assert.deepEqual(await bindings(), before);
    assert.equal(await mediaStatus(101), AVAILABLE);

    serveFakeLibrary(server, library);
    const read = await scan();
    assert.deepEqual(read, {
      ...NO_CHANGES,
      bindingsUpdated: 1,
      mediaUpdated: 1,
    });
    const [first] = await bindings();
    assert.deepEqual(
      [first.chapterCount, first.downloadCount, first.availability],
      [4, 2, PARTIALLY_AVAILABLE]
    );
    assert.equal(await mediaStatus(101), PARTIALLY_AVAILABLE);
  });

  it('leaves blocklisted media and AniList IDs of other media alone', async () => {
    const blocked = await createMangaMedia(
      dataSource.manager,
      101,
      MediaStatus.BLOCKLISTED
    );
    const show = await getRepository(Media).save(
      new Media({ mediaType: MediaType.TV, tmdbId: 9_001 })
    );
    await getRepository(MediaIdentifier).save(
      new MediaIdentifier({
        media: show,
        provider: MediaIdentifierProvider.ANILIST,
        value: '102',
        canonical: true,
      })
    );
    const server = await start({
      mangas: [
        tracked(1, 101, { chapterCount: 1, downloadCount: 1 }),
        tracked(2, 102, { chapterCount: 1, downloadCount: 1 }),
      ],
    });
    configure(instanceFor(server));

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsCreated: 2,
      warnings: { IDENTITY_CONFLICT: 1 },
    });
    const media = await getRepository(Media).find({ order: { id: 'ASC' } });
    assert.deepEqual(
      media.map(({ id, mediaType, status }) => [id, mediaType, status]),
      [
        [blocked.id, MediaType.MANGA, MediaStatus.BLOCKLISTED],
        [show.id, MediaType.TV, UNKNOWN],
      ]
    );
  });
});

describe('manga library scan: orphans', () => {
  it('orphans a vanished item, downgrades its media and reactivates it', async () => {
    const kept = tracked(1, 101, { chapterCount: 1, downloadCount: 1 });
    const leaving = tracked(2, 102, { chapterCount: 1, downloadCount: 1 });
    const library = { mangas: [kept, leaving, fakeLibraryManga(3)] };
    const server = await start(library);
    configure(instanceFor(server));
    await scan();

    library.mangas = [kept];
    assert.deepEqual(await scan(), {
      ...NO_CHANGES,
      bindingsOrphaned: 1,
      candidatesDeleted: 1,
      mediaUpdated: 1,
    });
    const [, orphan] = await bindings();
    assert.equal(orphan.state, MangaBindingState.ORPHANED);
    assert.equal(orphan.inLibrary, false);
    assert.equal(await mediaStatus(102), UNKNOWN);
    assert.equal(await mediaStatus(101), AVAILABLE);
    assert.deepEqual(await candidates(), []);

    library.mangas = [kept, leaving];
    assert.deepEqual(await scan(), {
      ...NO_CHANGES,
      bindingsReactivated: 1,
      mediaUpdated: 1,
    });
    assert.deepEqual((await bindings())[1].state, MangaBindingState.ACTIVE);
    assert.equal(await mediaStatus(102), AVAILABLE);
  });

  it('keeps the status of media with an active request', async () => {
    const library = {
      mangas: [tracked(1, 101, { chapterCount: 1, downloadCount: 1 })],
    };
    const server = await start(library);
    configure(instanceFor(server));
    await scan();
    const identifier = await getRepository(MediaIdentifier).findOneOrFail({
      where: { provider: MediaIdentifierProvider.ANILIST, value: '101' },
      relations: { media: true },
    });
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MANGA,
        media: identifier.media,
        requestedBy: await getRepository(User).findOneByOrFail({ id: 1 }),
        status: MediaRequestStatus.PENDING,
        is4k: false,
      })
    );

    library.mangas = [];
    assert.deepEqual(await scan(), { ...NO_CHANGES, bindingsOrphaned: 1 });
    assert.equal(await mediaStatus(101), AVAILABLE);
  });

  it('orphans the bindings of a removed instance without calling it', async () => {
    const first = await start({
      mangas: [
        tracked(1, 101, { chapterCount: 1, downloadCount: 1 }),
        tracked(2, 102, { chapterCount: 1, downloadCount: 1 }),
        fakeLibraryManga(3),
      ],
    });
    const second = await start({
      mangas: [tracked(9, 102, { chapterCount: 1, downloadCount: 1 })],
    });
    configure(instanceFor(first, 1), instanceFor(second, 2));
    await scan();
    configure(instanceFor(second, 2));
    const requests = first.requests.length;

    const counts = await scan();

    assert.equal(first.requests.length, requests);
    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsOrphaned: 2,
      candidatesDeleted: 1,
      mediaUpdated: 1,
    });
    assert.deepEqual(await bound(), [
      [1, 1, 101, MangaBindingState.ORPHANED, AVAILABLE],
      [1, 2, 102, MangaBindingState.ORPHANED, AVAILABLE],
      [2, 9, 102, MangaBindingState.ACTIVE, AVAILABLE],
    ]);
    assert.ok((await bindings()).slice(0, 2).every((b) => !b.inLibrary));
    assert.deepEqual(await candidates(), []);
    // 101 had no other copy; 102 waits for, and keeps, instance 2's copy.
    assert.equal(await mediaStatus(101), UNKNOWN);
    assert.equal(await mediaStatus(102), AVAILABLE);
  });

  it('applies a removed instance downgrade once the request that held it ends', async () => {
    const server = await start({
      mangas: [tracked(1, 101, { chapterCount: 1, downloadCount: 1 })],
    });
    configure(instanceFor(server));
    await scan();
    const identifier = await getRepository(MediaIdentifier).findOneOrFail({
      where: { provider: MediaIdentifierProvider.ANILIST, value: '101' },
      relations: { media: true },
    });
    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MANGA,
        media: identifier.media,
        requestedBy: await getRepository(User).findOneByOrFail({ id: 1 }),
        status: MediaRequestStatus.PENDING,
        is4k: false,
      })
    );
    configure();

    assert.deepEqual(await scan(), { ...NO_CHANGES, bindingsOrphaned: 1 });
    assert.equal(await mediaStatus(101), AVAILABLE);

    await dataSource
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ status: MediaRequestStatus.DECLINED })
      .where('id = :id', { id: request.id })
      .callListeners(false)
      .execute();
    assert.deepEqual(await scan(), { ...NO_CHANGES, mediaUpdated: 1 });
    assert.equal(await mediaStatus(101), UNKNOWN);
    assert.deepEqual(await scan(), NO_CHANGES);
    assert.equal(server.operations('LibraryPage').length, 1);
  });

  it('orphans nothing after an inconsistent listing', async () => {
    const one = tracked(1, 101, { chapterCount: 2, downloadCount: 1 });
    const two = tracked(2, 102, { chapterCount: 1, downloadCount: 1 });
    const server = await start({ mangas: [one, two] });
    configure(instanceFor(server));
    await scan();

    // One manga listed against a total of two.
    server.onOperation('LibraryPage', page([node(one)], 2));
    const mismatch = await scan();
    // A manga listed twice.
    server.onOperation(
      'LibraryPage',
      page([node(one)], 1, '1'),
      page([node(one)], 1)
    );
    const repeated = await scan();

    assert.deepEqual(mismatch, {
      ...NO_CHANGES,
      bindingsUpdated: 1,
      mediaUpdated: 1,
      warnings: { INCONSISTENT_LISTING: 1 },
    });
    assert.deepEqual(repeated, {
      ...NO_CHANGES,
      warnings: { INCONSISTENT_LISTING: 1 },
    });
    assert.deepEqual(await bound(), [
      [1, 1, 101, MangaBindingState.ACTIVE, AVAILABLE],
      [1, 2, 102, MangaBindingState.ACTIVE, AVAILABLE],
    ]);
  });

  it('keeps the lowest ID of a repeated URL and skips an overlong URL', async () => {
    const library = {
      mangas: [
        tracked(1, 101, { chapterCount: 1, downloadCount: 1 }),
        fakeLibraryManga(5, {
          url: '/fake-library/shared',
          title: '\u{1D504}'.repeat(600),
        }),
        fakeLibraryManga(7, { url: '/fake-library/shared' }),
        fakeLibraryManga(8, { url: `/${'u'.repeat(2_048)}` }),
      ],
    };
    const server = await start(library);
    configure(instanceFor(server));

    const counts = await scan();

    assert.deepEqual(counts.warnings, {
      SKIPPED_URL: 1,
      DUPLICATE_SOURCE_URL: 1,
    });
    const [candidate] = await candidates();
    assert.equal(candidate.suwayomiMangaId, 5);
    assert.equal(Array.from(candidate.title).length, 512);
    assert.equal((await candidates()).length, 1);

    // Both still count toward the total, so the listing stays consistent.
    library.mangas.splice(0, 1);
    assert.deepEqual(await scan(), {
      ...NO_CHANGES,
      bindingsOrphaned: 1,
      mediaUpdated: 1,
      warnings: { SKIPPED_URL: 1, DUPLICATE_SOURCE_URL: 1 },
    });
  });
});

describe('manga library scan: several instances', () => {
  it('scans the other instances when one has settings no client accepts', async () => {
    const broken = await start({
      mangas: [tracked(1, 101, { chapterCount: 1, downloadCount: 1 })],
    });
    const healthy = await start({
      mangas: [tracked(1, 102, { chapterCount: 1, downloadCount: 1 })],
    });
    configure(
      instanceFor(broken, 1, {
        authMode: 'BASIC_AUTH',
        username: '',
        password: '',
      }),
      instanceFor(healthy, 2)
    );

    assert.deepEqual(await scan(), {
      ...NO_CHANGES,
      bindingsCreated: 1,
      mediaCreated: 1,
      warnings: { INSTANCE_FAILED: 1 },
    });
    assert.deepEqual(broken.requests, []);
    assert.deepEqual(await bound(), [
      [2, 1, 102, MangaBindingState.ACTIVE, AVAILABLE],
    ]);
    assert.equal(await mediaStatus(102), AVAILABLE);
  });

  it('downgrades only once every instance holding the title was read', async () => {
    const first = {
      mangas: [
        tracked(1, 101, { chapterCount: 2, downloadCount: 1 }),
        tracked(2, 102, { chapterCount: 2, downloadCount: 1 }),
      ],
    };
    const second = {
      mangas: [
        tracked(1, 101, { chapterCount: 2, downloadCount: 2 }),
        tracked(2, 102, { chapterCount: 2, downloadCount: 1 }),
      ],
    };
    const one = await start(first);
    const two = await start(second);
    configure(instanceFor(one, 1), instanceFor(two, 2));
    await scan();
    assert.equal(await mediaStatus(101), AVAILABLE);
    assert.equal(await mediaStatus(102), PARTIALLY_AVAILABLE);

    // Instance 2 fails: instance 1's lower value for 101 waits, while its
    // upgrade of 102 applies.
    first.mangas[1] = tracked(2, 102, { chapterCount: 2, downloadCount: 2 });
    two.onOperation('LibraryPage', graphqlErrors([syntheticFailure()]));
    const counts = await scan();
    assert.deepEqual(counts.warnings, { INSTANCE_FAILED: 1 });
    assert.equal(counts.mediaUpdated, 1);
    assert.equal(await mediaStatus(101), AVAILABLE);
    assert.equal(await mediaStatus(102), AVAILABLE);

    // Both healthy: the downgrade happens once instance 2 was read too.
    second.mangas[0] = tracked(1, 101, { chapterCount: 2 });
    serveFakeLibrary(two, second);
    let between: MediaStatus | undefined;
    two.onOperation('Capabilities', async () => {
      between = await mediaStatus(101);
      return TRACKING;
    });
    await scan();
    assert.equal(between, AVAILABLE);
    assert.equal(await mediaStatus(101), PARTIALLY_AVAILABLE);
  });

  it('looks up every title of every instance in one run', async () => {
    const library = (from: number, count: number) => ({
      mangas: Array.from({ length: count }, (_, index) =>
        fakeLibraryManga(from + index)
      ),
    });
    const one = await start(library(1, 12));
    const two = await start(library(21, 2));
    const three = await start(library(31, 12));
    configure(instanceFor(one, 1), instanceFor(two, 2), instanceFor(three, 3));
    lookups.titles.mock.mockImplementation(async (search: string) =>
      search === 'Fake Library Title 22'
        ? [anilistManga(422, 'Fake Library Title 22 Extra')]
        : []
    );
    const logs = captureLogs();

    const counts = await scan();

    const ids = [
      ...Array.from({ length: 12 }, (_, index) => 1 + index),
      21,
      22,
      ...Array.from({ length: 12 }, (_, index) => 31 + index),
    ];
    assert.deepEqual(
      titleSearches(),
      ids.map((id) => `Fake Library Title ${id}`)
    );
    assert.deepEqual(deferredLookups(logs), []);
    const { progress: handled, total } = mangaLibraryScanner.status();
    assert.deepEqual([handled, total], [26, 26]);
    assert.deepEqual(completion(logs), {
      ...counts,
      listed: 26,
      bound: {},
      proposed: 1,
      unmatched: 25,
    });
  });

  it('reads every page of each MAL lookup, instance after instance', async () => {
    const one = await start({ mangas: [malTracked(1, 55)] });
    const two = await start({ mangas: [malTracked(2, 56)] });
    configure(instanceFor(one, 1), instanceFor(two, 2));
    lookups.mal.mock.mockImplementation(
      async (malIds: readonly number[], page: number) => ({
        hasNextPage: malIds.includes(55) && page < 7,
        links:
          page === 1
            ? malIds.map((malId) => ({ anilistId: malId + 100, malId }))
            : [],
      })
    );

    const counts = await scan();

    assert.equal(counts.bindingsCreated, 2);
    assert.deepEqual(
      lookups.mal.mock.calls.map(({ arguments: [malIds, page] }) => [
        malIds,
        page,
      ]),
      [...[1, 2, 3, 4, 5, 6, 7].map((page) => [[55], page]), [[56], 1]]
    );
  });
});

describe('manga library scan: guards', () => {
  it('writes nothing for a server it cannot read safely', async () => {
    const library = {
      mangas: [tracked(1, 101, { chapterCount: 1, downloadCount: 1 })],
    };
    const server = await start(library);
    configure(instanceFor(server));
    await scan();
    const before = await bindings();
    library.mangas = [];

    server.onOperation('Capabilities', capabilitiesData({ queryFields: [] }));
    assert.deepEqual(await scan(), {
      ...NO_CHANGES,
      warnings: { UNSUPPORTED_SERVER: 1 },
    });
    server.onOperation(
      'Capabilities',
      capabilitiesData({ mangaFields: ['id', 'title', 'trackRecords', 'user'] })
    );
    assert.deepEqual(await scan(), {
      ...NO_CHANGES,
      warnings: { PER_USER_SCHEMA: 1 },
    });

    assert.equal(server.operations('LibraryPage').length, 1);
    assert.deepEqual(await bindings(), before);
    assert.equal(await mediaStatus(101), AVAILABLE);
  });

  it('writes nothing once the login changes during the reads', async () => {
    const server = await start({
      mangas: [
        tracked(1, 101, { chapterCount: 1, downloadCount: 1 }),
        fakeLibraryManga(2),
      ],
    });
    configure(instanceFor(server));
    server.onOperation('Capabilities', () => {
      settings.suwayomi[0].password = randomUUID();
      return TRACKING;
    });

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      warnings: { INSTANCE_CHANGED: 1 },
    });
    assert.ok(server.operations('LibraryTrackRecords').length > 0);
    assert.deepEqual(await bindings(), []);
    assert.deepEqual(await candidates(), []);
    assert.deepEqual(await getRepository(Media).find(), []);
  });

  it('copies the instance before it creates the client', async () => {
    const server = await start({ mangas: [fakeLibraryManga(1)] });
    configure(instanceFor(server));
    const key = Symbol.for('seerrng.test.externalRuntimeConfig');
    const provider = Reflect.get(globalThis, key) as () => unknown;
    let changed = false;
    // Changes the stored login while the client factory reads the settings.
    Reflect.set(globalThis, key, () => {
      if (!changed && new Error().stack?.includes('getSuwayomiClient')) {
        changed = true;
        settings.suwayomi = [{ ...settings.suwayomi[0], username: 'other' }];
      }
      return provider();
    });

    try {
      assert.deepEqual(await scan(), {
        ...NO_CHANGES,
        warnings: { INSTANCE_CHANGED: 1 },
      });
    } finally {
      Reflect.set(globalThis, key, provider);
    }
    assert.equal(changed, true);
    assert.deepEqual(await candidates(), []);
  });

  it('skips a source manga whose rows changed after they were read', async () => {
    const library = {
      mangas: [
        fakeLibraryManga(1),
        tracked(2, 102, { chapterCount: 2, downloadCount: 1 }),
      ],
    };
    const server = await start(library);
    configure(instanceFor(server));
    await scan();
    library.mangas = [
      fakeLibraryManga(1, { title: 'Fake Library Title 1b' }),
      tracked(2, 102, { chapterCount: 2, downloadCount: 2 }),
    ];
    server.onOperation('LibraryTrackRecords', async () => {
      await getRepository(MangaMatchCandidate).update(
        { suwayomiMangaId: 1 },
        { title: 'Edited Elsewhere' }
      );
      return graphqlData({
        mangas: { nodes: [{ id: 1, trackRecords: { nodes: [] } }] },
      });
    });
    const logs = captureLogs();

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsUpdated: 1,
      mediaUpdated: 1,
      warnings: { ROW_CHANGED: 1 },
    });
    // The skipped title is in the warnings, not in the totals.
    assert.deepEqual(completion(logs), {
      ...counts,
      listed: 2,
      bound: { 'anilist-tracker': 1 },
      proposed: 0,
      unmatched: 0,
    });
    assert.equal((await candidates())[0].title, 'Edited Elsewhere');
    assert.equal(await mediaStatus(102), AVAILABLE);
  });

  it('keeps a binding that dispatch adds to the library after the listing', async () => {
    const manga = fakeLibraryManga(1);
    const library: FakeLibrary = { mangas: [] };
    const server = await start(library);
    configure(instanceFor(server));
    const repository = getRepository(MangaSourceBinding);
    await repository.insert(unlistedBinding(manga, 101));
    // Dispatch adds the manga once the listing is taken, so it is not listed.
    listWhile(server, library, () =>
      repository.update({ anilistId: 101 }, { inLibrary: true })
    );

    assert.deepEqual(await scan(), NO_CHANGES);
    assert.deepEqual(await bound(), [
      [1, 1, 101, MangaBindingState.ACTIVE, UNKNOWN],
    ]);
    assert.equal((await bindings())[0].inLibrary, true);

    library.mangas = [manga];
    assert.deepEqual(await scan(), {
      ...NO_CHANGES,
      bindingsUpdated: 1,
      mediaCreated: 1,
    });
    assert.deepEqual(await bound(), [
      [1, 1, 101, MangaBindingState.ACTIVE, AVAILABLE],
    ]);
  });

  for (const [action, stored] of [
    ['marks as in the library', true],
    ['binds', false],
  ] as const) {
    it(`leaves an item that another writer ${action} during the listing to the next scan`, async () => {
      const manga = fakeLibraryManga(1);
      const library: FakeLibrary = { mangas: [manga] };
      const server = await start(library);
      configure(instanceFor(server));
      const repository = getRepository(MangaSourceBinding);
      const row = unlistedBinding(manga, 101);
      if (stored) await repository.insert(row);
      // Dispatch adds the stored binding's manga, or an admin binds the item.
      listWhile(server, library, () =>
        stored
          ? repository.update({ anilistId: 101 }, { inLibrary: true })
          : repository.insert({
              ...row,
              confidence: MangaBindingConfidence.MANUAL,
              matchedBy: 'manual',
              origin: 'admin',
              inLibrary: true,
            })
      );

      assert.deepEqual(await scan(), {
        ...NO_CHANGES,
        warnings: { ROW_CHANGED: 1 },
      });
      assert.equal(mangaLibraryScanner.status().running, false);
      assert.deepEqual(await bound(), [
        [1, 1, 101, MangaBindingState.ACTIVE, UNKNOWN],
      ]);
      assert.equal((await bindings())[0].inLibrary, true);
      assert.deepEqual(await candidates(), []);

      assert.deepEqual(await scan(), {
        ...NO_CHANGES,
        bindingsUpdated: 1,
        mediaCreated: 1,
      });
      assert.deepEqual(await bound(), [
        [1, 1, 101, MangaBindingState.ACTIVE, AVAILABLE],
      ]);
      assert.deepEqual(await candidates(), []);
    });
  }

  it('skips a row that hits a unique key and finishes the run', async () => {
    const server = await start({
      mangas: [
        fakeLibraryManga(1),
        tracked(2, 102, { chapterCount: 1, downloadCount: 1 }),
      ],
    });
    configure(instanceFor(server));
    // Stands in for a concurrent insert the batch re-read cannot see: the
    // same unique key, filed under another URL.
    server.onOperation('LibraryTrackRecords', async () => {
      await getRepository(MangaMatchCandidate).insert({
        instanceId: 1,
        sourceId: '0',
        url: '/fake-library/elsewhere',
        urlHash: hashMangaSourceUrl('/fake-library/1'),
        suwayomiMangaId: 99,
        title: 'Fake Library Title 99',
      });
      return graphqlData({
        mangas: {
          nodes: [
            { id: 1, trackRecords: { nodes: [] } },
            {
              id: 2,
              trackRecords: {
                nodes: [{ trackerId: aniList, remoteId: '102' }],
              },
            },
          ],
        },
      });
    });
    const logs = captureLogs();

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsCreated: 1,
      mediaCreated: 1,
      warnings: { UNIQUE_CONFLICT: 1 },
    });
    assert.deepEqual(completion(logs), {
      ...counts,
      listed: 2,
      bound: { 'anilist-tracker': 1 },
      proposed: 0,
      unmatched: 0,
    });
    assert.deepEqual(
      (await candidates()).map(({ suwayomiMangaId }) => suwayomiMangaId),
      [99]
    );
    assert.equal(await mediaStatus(102), AVAILABLE);
  });

  it('cancels the read in flight and writes nothing after it', async () => {
    const server = await start({
      mangas: [tracked(1, 101, { chapterCount: 1, downloadCount: 1 })],
    });
    configure(instanceFor(server));
    let reached!: () => void;
    const pageRequested = new Promise<void>((resolve) => (reached = resolve));
    server.onOperation('LibraryPage', () => {
      reached();
      return { hang: true };
    });

    const running = mangaLibraryScanner.run();
    await pageRequested;
    mangaLibraryScanner.cancel();
    await running;

    const [request] = server.operations('LibraryPage');
    assert.equal(await request.closed, false);
    assert.equal(mangaLibraryScanner.status().running, false);
    assert.deepEqual(mangaLibraryScanner.status().counts, NO_CHANGES);
    assert.deepEqual(await bindings(), []);
    assert.deepEqual(await getRepository(Media).find(), []);
  });

  it('does nothing while manga is off or no instance is configured', async () => {
    const server = await start({
      mangas: [tracked(1, 101, { chapterCount: 1, downloadCount: 1 })],
    });
    configure(instanceFor(server));
    settings.main.enabledMediaCategories = { ...categories, manga: false };

    await mangaLibraryScanner.run();

    assert.deepEqual(server.requests, []);
    settings.main.enabledMediaCategories = { ...categories, manga: true };
    configure();
    assert.deepEqual(await scan(), NO_CHANGES);
    assert.deepEqual(server.requests, []);
    assert.deepEqual(await bindings(), []);
  });
});

describe('manga library scan: requests', () => {
  /**
   * Outbox deliveries wait until `deliver()`, so the rows a scan writes stay
   * visible. Each then runs the real dispatch.
   */
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  const hold = () => {
    gate = new Promise((resolve) => {
      open = resolve;
    });
  };
  const deliver = async () => {
    open();
    await waitForBackgroundTasks();
    hold();
  };

  beforeEach(() => {
    hold();
    const subscriber = new MediaRequestSubscriber();
    const dispatch = subscriber.dispatchRequestById.bind(subscriber);
    mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async (requestId: number) => {
        await gate;
        return dispatch(requestId);
      }
    );
  });

  afterEach(async () => {
    await deliver();
  });

  const outbox = async () =>
    (
      await getRepository(RequestDispatchOutbox).find({ order: { id: 'ASC' } })
    ).map(({ requestId }) => requestId);

  /**
   * A manga request as the request flow records it. Its approval's delivery
   * runs before the manifest exists, so it sends nothing and leaves the
   * outbox.
   */
  const recordRequest = async (
    anilistId: number,
    instanceId = 1,
    bindingState = MangaRequestBindingState.AWAITING_BINDING
  ) => {
    const media = await createMangaMedia(
      dataSource.manager,
      anilistId,
      MediaStatus.PENDING
    );
    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MANGA,
        media,
        requestedBy: await getRepository(User).findOneByOrFail({ id: 1 }),
        status: MediaRequestStatus.APPROVED,
        is4k: false,
        serverId: instanceId,
      })
    );
    await deliver();
    await getRepository(MangaRequestManifest).insert({
      requestId: request.id,
      anilistId,
      instanceId,
      bindingState,
    });
    return request.id;
  };

  const manifests = async () =>
    (
      await getRepository(MangaRequestManifest).find({ order: { id: 'ASC' } })
    ).map((manifest) => [
      manifest.anilistId,
      manifest.instanceId,
      manifest.bindingState,
      manifest.boundAt instanceof Date,
    ]);

  const { AWAITING_BINDING, BOUND } = MangaRequestBindingState;

  it('releases parked requests once their title is bound and parks them when it goes', async () => {
    const library = {
      mangas: [tracked(1, 101, { chapterCount: 2, downloadCount: 1 })],
    };
    const server = await start(library);
    configure(instanceFor(server));
    const released = await recordRequest(101);
    await recordRequest(109);
    // A stale BOUND row for a title no binding names: only the sweep sees it.
    await recordRequest(555, 1, BOUND);

    await scan();

    assert.deepEqual(await manifests(), [
      [101, 1, BOUND, true],
      [109, 1, AWAITING_BINDING, false],
      [555, 1, AWAITING_BINDING, false],
    ]);
    // The scan queues the request its title's new binding released.
    assert.deepEqual(await outbox(), [released]);

    library.mangas = [];
    await scan();

    assert.deepEqual(await manifests(), [
      [101, 1, AWAITING_BINDING, false],
      [109, 1, AWAITING_BINDING, false],
      [555, 1, AWAITING_BINDING, false],
    ]);
    // The re-park leaves the row. Its delivery finds the request parked and
    // sends nothing.
    assert.deepEqual(await outbox(), [released]);
    await deliver();
    assert.equal(await getRepository(RequestDispatchOutbox).count(), 0);
    assertReadsOnly(server);
  });

  it('keeps a request parked while only another instance holds its title', async () => {
    const first = await start({
      mangas: [tracked(1, 101, { chapterCount: 1, downloadCount: 1 })],
    });
    const second = await start({ mangas: [] });
    configure(instanceFor(first, 1), instanceFor(second, 2));
    await recordRequest(101, 2);

    await scan();

    assert.deepEqual(await manifests(), [[101, 2, AWAITING_BINDING, false]]);
    assert.equal(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('releases a parked request once a confident title match binds its title', async () => {
    const server = await start({
      mangas: [fakeLibraryManga(1, { chapterCount: 2, downloadCount: 1 })],
    });
    configure(instanceFor(server));
    lookups.titles.mock.mockImplementation(async () => [
      anilistManga(401, 'Fake Library Title 1'),
    ]);
    const released = await recordRequest(401);

    await scan();

    assert.deepEqual(await manifests(), [[401, 1, BOUND, true]]);
    assert.deepEqual(await outbox(), [released]);
  });
});

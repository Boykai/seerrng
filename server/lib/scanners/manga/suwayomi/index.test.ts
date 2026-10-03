import AnilistAPI, {
  AnilistBadResponseError,
  AnilistGraphQLError,
  AnilistRateLimitedError,
} from '@server/api/anilist';
import type { AnilistMangaSummary } from '@server/api/anilist/manga';
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
import { Kind, OperationTypeNode, parse } from 'graphql';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';
import { mangaLibraryScanner } from './index';

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
  synonyms: string[] = []
): AnilistMangaSummary => ({
  id,
  titles: { romaji },
  synonyms,
  isAdult: false,
  genres: [],
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

/** Per instance: the MAL, MangaDex and title lookups the cap left over. */
const deferredLookups = (logs: unknown[]) =>
  (logs as [string, Record<string, unknown>][])
    .filter(
      ([message]) => message === 'Manga library lookups left for a later run'
    )
    .map(([, meta]) => [meta.instanceId, meta.mal, meta.mangadex, meta.title]);

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  configure();
  lookups = stubLookups();
});

afterEach(async () => {
  mock.restoreAll();
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

    const targets = connect.mock.calls.map(({ arguments: [first] }) => {
      const options = (Array.isArray(first) ? first[0] : first) as {
        host?: string;
        port?: number | string;
      };
      return `${options.host}:${options.port}`;
    });
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

  for (const [name, failure, cause] of [
    ['rate-limited', () => new AnilistRateLimitedError(60), 'RATE_LIMITED'],
    ['malformed', () => new AnilistBadResponseError(), 'BAD_RESPONSE'],
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
      assert.equal(lookups.mal.mock.callCount(), 3);
      const rows = await progress();
      assert.equal(rows.filter(([, , malChecked]) => malChecked).length, 50);
      assert.deepEqual(rows[50], [51, null, false, false, false]);
      // Step 3 failed for item 51 alone; the title step still ran.
      assert.equal(titleSearches().length, 10);
      assert.equal(titleSearches().includes('Fake Library Title 51'), false);
      assert.match(inspect(logs, { depth: 8 }), new RegExp(cause));
    });
  }

  it('stops at the call cap and leaves the batch for a later run', async () => {
    const server = await start({ mangas: [malTracked(1, 55)] });
    configure(instanceFor(server));
    lookups.mal.mock.mockImplementation(async () => ({
      hasNextPage: true,
      links: [],
    }));
    const logs = captureLogs();

    const counts = await scan();

    assert.equal(lookups.mal.mock.callCount(), 10);
    assert.deepEqual(counts, { ...NO_CHANGES, candidatesCreated: 1 });
    assert.deepEqual(await progress(), [[1, null, false, false, false]]);
    assert.deepEqual(titleSearches(), []);
    // The cap is not a warning, but the deferred work is logged.
    assert.deepEqual(deferredLookups(logs), [[1, 1, undefined, undefined]]);
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

  it('leaves MangaDex items unchecked when MangaDex refuses', async () => {
    const server = await start({
      mangas: [
        fakeLibraryManga(1, { url: `/manga/${uuid(1)}` }),
        fakeLibraryManga(2, { url: `/manga/${uuid(2)}` }),
        fakeLibraryManga(3),
      ],
    });
    configure(instanceFor(server));
    lookups.mangadex.mock.mockImplementation(async () => {
      throw new MangaDexRateLimitedError(60, true);
    });
    const logs = captureLogs();

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      candidatesCreated: 3,
      warnings: { MANGADEX_LOOKUP_FAILED: 2 },
    });
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

  it('stores the best title match for review and never binds it', async () => {
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

    assert.deepEqual(counts, { ...NO_CHANGES, candidatesCreated: 4 });
    assert.deepEqual(await bindings(), []);
    assert.deepEqual(await getRepository(Media).find(), []);
    const stored = await proposals();
    assert.deepEqual(stored.slice(0, 2), [
      [1, 401, MangaBindingConfidence.HIGH, 1000],
      [2, 403, MangaBindingConfidence.MEDIUM, 1000],
    ]);
    // The best weak match is kept, ranked LOW.
    assert.deepEqual(stored[2].slice(0, 3), [
      3,
      405,
      MangaBindingConfidence.LOW,
    ]);
    assert.ok((stored[2][3] as number) < 750);
    assert.deepEqual(stored[3], [4, null, null, null]);
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
    const results: Record<string, AnilistMangaSummary[]> = {
      'Fake Library Title 1': [anilistManga(401, 'Fake Library Title 1')],
      'Fake Library Title 2': [
        anilistManga(402, 'Fake Library Title 2'),
        anilistManga(403, 'Fake Library Title 2 Remake'),
      ],
    };
    const search = async (text: string) => results[text] ?? [];
    lookups.titles.mock.mockImplementation(search);
    await scan();
    const proposed = async () =>
      (await proposals()).map(([id, anilistId]) => [id, anilistId]);
    assert.deepEqual(await proposed(), [
      [1, 401],
      [2, 402],
    ]);

    // While AniList refuses every search, both stale proposals still go.
    await getRepository(MangaSourceBinding).insert(rejectedRow(2, 402));
    library.mangas[0] = fakeLibraryManga(1, { title: 'Fake Library Title 1b' });
    lookups.titles.mock.mockImplementation(async () => {
      throw new AnilistRateLimitedError(60);
    });

    const counts = await scan();

    assert.deepEqual(counts.warnings, { TITLE_SEARCH_FAILED: 1 });
    assert.equal(lookups.titles.mock.callCount(), 3);
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
      [1, null],
      [2, 403],
    ]);
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

  it('searches never-checked titles first and each again after 30 days', async () => {
    const server = await start({
      mangas: Array.from({ length: 12 }, (_, index) =>
        fakeLibraryManga(index + 1)
      ),
    });
    configure(instanceFor(server));
    const titles = (...ids: number[]) =>
      ids.map((id) => `Fake Library Title ${id}`);

    await scan();
    assert.deepEqual(titleSearches(), titles(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));

    lookups.titles.mock.resetCalls();
    await scan();
    assert.deepEqual(titleSearches(), titles(11, 12));

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
    lookups.titles.mock.resetCalls();
    await scan();
    assert.deepEqual(titleSearches(), titles(3, 1));
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

  it("shares each run's lookups between the instances", async () => {
    const library = (from: number, count: number) => ({
      mangas: Array.from({ length: count }, (_, index) =>
        fakeLibraryManga(from + index)
      ),
    });
    const one = await start(library(1, 12));
    const two = await start(library(21, 2));
    const three = await start(library(31, 12));
    configure(instanceFor(one, 1), instanceFor(two, 2), instanceFor(three, 3));
    const logs = captureLogs();

    await scan();

    // Of 10 searches, the first of three instances gets 4, the second needs
    // only 2 of its 3, and the last gets the 4 left.
    assert.deepEqual(
      titleSearches(),
      [1, 2, 3, 4, 21, 22, 31, 32, 33, 34].map(
        (id) => `Fake Library Title ${id}`
      )
    );
    assert.deepEqual(deferredLookups(logs), [
      [1, undefined, undefined, 8],
      [3, undefined, undefined, 8],
    ]);
  });

  it('lets a started MAL lookup finish on the calls left in the run', async () => {
    const one = await start({ mangas: [malTracked(1, 55)] });
    const two = await start({ mangas: [malTracked(2, 56)] });
    configure(instanceFor(one, 1), instanceFor(two, 2));
    // Instance 1's share is 5 calls, but its lookup has 7 pages.
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

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsUpdated: 1,
      mediaUpdated: 1,
      warnings: { ROW_CHANGED: 1 },
    });
    assert.equal((await candidates())[0].title, 'Edited Elsewhere');
    assert.equal(await mediaStatus(102), AVAILABLE);
  });

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

    const counts = await scan();

    assert.deepEqual(counts, {
      ...NO_CHANGES,
      bindingsCreated: 1,
      mediaCreated: 1,
      warnings: { UNIQUE_CONFLICT: 1 },
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
  /** A manga request as the request flow records it, before any dispatch. */
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
    await getRepository(MangaRequestManifest).insert({
      requestId: request.id,
      anilistId,
      instanceId,
      bindingState,
    });
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
    await recordRequest(101);
    await recordRequest(109);
    // A stale BOUND row for a title no binding names: only the sweep sees it.
    await recordRequest(555, 1, BOUND);

    await scan();

    assert.deepEqual(await manifests(), [
      [101, 1, BOUND, true],
      [109, 1, AWAITING_BINDING, false],
      [555, 1, AWAITING_BINDING, false],
    ]);

    library.mangas = [];
    await scan();

    assert.deepEqual(await manifests(), [
      [101, 1, AWAITING_BINDING, false],
      [109, 1, AWAITING_BINDING, false],
      [555, 1, AWAITING_BINDING, false],
    ]);
    assert.equal(await getRepository(RequestDispatchOutbox).count(), 0);
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
});

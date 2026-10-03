import AnilistAPI, {
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist';
import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import MangaDexAPI, {
  MangaDexBadResponseError,
  MangaDexRateLimitedError,
  type MangaDexTitleMatch,
} from '@server/api/mangadex';
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
import MangaSourceCandidate from '@server/entity/MangaSourceCandidate';
import MangaSourceResolution, {
  MangaResolutionStatus,
} from '@server/entity/MangaSourceResolution';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { createMangaMedia, getMangaAdmissionKey } from '@server/lib/mangaMedia';
import { DEFAULT_MANGA_REQUEST_SCOPE } from '@server/lib/mangaRequests';
import {
  MangaSourceResolver,
  mangaNoMatchDelayMs,
  type MangaResolverLimits,
} from '@server/lib/mangaResolver';
import { requestMangaTitleSearch } from '@server/lib/mangaResolver/titles';
import requestAdmissionCoordinator from '@server/lib/requestAdmission';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { setupTestDb } from '@server/test/db';
import {
  capabilitiesData,
  graphqlData,
  graphqlErrors,
  startFakeSuwayomi,
  syntheticFailure,
  type FakeReply,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import { Kind, OperationTypeNode, parse } from 'graphql';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

const PASSWORD = randomUUID();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const [T1, T2, T3] = [910001, 910002, 910003];
const OTHER_TITLE = 910009;
const uuid = (n: number) =>
  `0a0a0a0a-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [U1, U2, U3] = [uuid(1), uuid(2), uuid(3)];
const { APPROVED, PENDING } = MediaRequestStatus;
const { AWAITING_BINDING, BOUND } = MangaRequestBindingState;
const settings = getSettings();
const original = {
  categories: settings.main.enabledMediaCategories,
  includeAdult: settings.main.mangaIncludeAdult,
  includeNovels: settings.main.mangaIncludeNovels,
};
const servers: FakeSuwayomi[] = [];

let clock = 0;
let searches: string[] = [];
let anilistCalls: number[] = [];
let mangadexCalls: string[] = [];
/** Outside calls made while an admission was held. */
let violations: string[] = [];
let admissions: { resources: string[]; depth: number }[] = [];
let depth = 0;
const anilistReplies = new Map<number, AnilistMangaDetails | null | Error>();
const mangadexReplies = new Map<string, MangaDexTitleMatch[] | Error>();

const advance = (ms: number) => {
  clock = Math.max(clock, Date.now()) + ms;
};
const resolver = (limits: Partial<MangaResolverLimits> = {}) =>
  new MangaSourceResolver({ limits, now: () => clock });
const outside = (service: string) => {
  if (depth > 0) violations.push(service);
};

const originalRun = requestAdmissionCoordinator.run.bind(
  requestAdmissionCoordinator
);
const observedRun: typeof requestAdmissionCoordinator.run = (
  resources,
  callback
) => {
  admissions.push({ resources: [...resources], depth });
  return originalRun(resources, async () => {
    depth += 1;
    try {
      return await callback();
    } finally {
      depth -= 1;
    }
  });
};

const englishOf = (anilistId: number) => `Synthetic Title ${anilistId}`;
const romajiOf = (anilistId: number) => `Gousei Taitoru ${anilistId}`;

const details = (
  id: number,
  overrides: Partial<AnilistMangaDetails> = {}
): AnilistMangaDetails => ({
  id,
  titles: { english: englishOf(id), romaji: romajiOf(id) },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  tags: [],
  staff: [],
  countryOfOrigin: 'JP',
  ...overrides,
});

/** MangaDex finds these manga for the title's English name. */
const link = (anilistId: number, ...uuids: string[]) =>
  mangadexReplies.set(
    englishOf(anilistId),
    uuids.map((value) => ({ uuid: value, anilistId }))
  );

interface FakeSource {
  id: string;
  lang?: string;
  contentWarning?: string;
}

interface FakeHit {
  id: number;
  url: string;
  title: string;
  inLibrary?: boolean;
}

type SearchReply = FakeHit[] | FakeReply;

const exactHit = (
  id: number,
  value: string,
  overrides: Partial<FakeHit> = {}
): FakeHit => ({
  id,
  url: `/manga/${value}`,
  title: `Synthetic Source Title ${id}`,
  ...overrides,
});

const titleHit = (id: number, title: string): FakeHit => ({
  id,
  url: `/fake-title/${id}`,
  title,
});

/** A distinct Suwayomi manga ID per source and item. */
const itemId = (sourceId: string, n: number) =>
  (Number(sourceId) - 1000) * 100 + n;

/** Only the `id:` probe for `value` finds `hit`. */
const probeFinds =
  (value: string, hit: FakeHit) =>
  (_sourceId: string, query: string): SearchReply =>
    query === `id:${value}` ? [hit] : [];

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

/** Serves `sources` from a fake server configured as instance 1. */
const serve = async ({
  sources,
  search = () => [],
  capabilities = capabilitiesData(),
  instance = {},
}: {
  sources: FakeSource[];
  search?: (sourceId: string, query: string) => SearchReply;
  capabilities?: FakeReply;
  instance?: Partial<SuwayomiSettings>;
}): Promise<FakeSuwayomi> => {
  const server = await startFakeSuwayomi({
    mode: 'NONE',
    username: 'fake-user',
    password: PASSWORD,
  });
  servers.push(server);
  server.onOperation('Capabilities', () => {
    outside('suwayomi');
    return capabilities;
  });
  server.onOperation('Sources', () => {
    outside('suwayomi');
    return graphqlData({
      sources: {
        nodes: sources.map(({ id, lang = 'en', contentWarning = 'SAFE' }) => ({
          id,
          name: `fake-${id}`,
          displayName: `Fake Source ${id}`,
          lang,
          contentWarning,
          supportsLatest: false,
          extension: { hasUpdate: false, isObsolete: false },
        })),
      },
    });
  });
  server.onOperation('SearchSource', (sent) => {
    outside('suwayomi');
    const sourceId = String(sent.variables.source);
    const query = String(sent.variables.query);
    searches.push(`${sourceId} ${query}`);
    const reply = search(sourceId, query);
    if (!Array.isArray(reply)) return reply;
    return graphqlData({
      fetchSourceManga: {
        hasNextPage: false,
        mangas: reply.map((hit) => ({
          id: hit.id,
          sourceId,
          url: hit.url,
          title: hit.title,
          author: null,
          status: 'ONGOING',
          inLibrary: hit.inLibrary ?? false,
          initialized: true,
        })),
      },
    });
  });
  const url = new URL(server.url);
  configure({
    id: 1,
    name: 'Suwayomi 1',
    hostname: url.hostname,
    port: Number(url.port),
    useSsl: false,
    baseUrl: '',
    isDefault: true,
    authMode: 'NONE',
    username: 'fake-user',
    password: PASSWORD,
    sourceAllowlist: sources.map(({ id }) => id),
    preferredLanguages: [],
    scanlatorPreference: [],
    requireCbz: true,
    ...instance,
  });
  return server;
};

/** A manga request whose manifest waits for a binding on instance 1. */
const seedRequest = async (anilistId: number, status = APPROVED) => {
  const media = await createMangaMedia(
    dataSource.manager,
    anilistId,
    MediaStatus.PENDING
  );
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MANGA,
      status,
      media,
      requestedBy,
      is4k: false,
      serverId: 1,
    })
  );
  await getRepository(MangaRequestManifest).save(
    new MangaRequestManifest({
      requestId: request.id,
      anilistId,
      instanceId: 1,
      ...DEFAULT_MANGA_REQUEST_SCOPE,
    })
  );
  return request.id;
};

/** A library scan's ACTIVE binding on source 1001, by default. */
const seedBinding = (
  anilistId: number,
  url: string,
  overrides: Partial<MangaSourceBinding> = {}
) =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId: 1,
      sourceId: '1001',
      url,
      urlHash: hashMangaSourceUrl(url),
      anilistId,
      suwayomiMangaId: 701,
      title: 'Synthetic Bound Title',
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state: MangaBindingState.ACTIVE,
      inLibrary: true,
      ...overrides,
    })
  );

const seedResolution = (
  anilistId: number,
  overrides: Partial<MangaSourceResolution>
) =>
  getRepository(MangaSourceResolution).save(
    new MangaSourceResolution({ instanceId: 1, anilistId, ...overrides })
  );

const resolution = (anilistId: number) =>
  getRepository(MangaSourceResolution).findOneBy({ instanceId: 1, anilistId });

const stateOf = async (anilistId: number) => {
  const row = await resolution(anilistId);
  assert.ok(row, `no resolver row for ${anilistId}`);
  return {
    status: row.status,
    reason: row.reason,
    mangadexUuid: row.mangadexUuid,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.getTime() ?? null,
    lastError: row.lastError,
  };
};

const candidatesOf = async (anilistId: number) =>
  (
    await getRepository(MangaSourceCandidate).find({
      where: { instanceId: 1, anilistId },
      order: { score: 'DESC', id: 'ASC' },
    })
  ).map(
    ({
      sourceId,
      sourceName,
      sourceLang,
      url,
      suwayomiMangaId,
      inLibrary,
      score,
      confidence,
      matchedBy,
    }) => ({
      sourceId,
      sourceName,
      sourceLang,
      url,
      suwayomiMangaId,
      inLibrary,
      score,
      confidence,
      matchedBy,
    })
  );

const bindings = () =>
  getRepository(MangaSourceBinding).find({ order: { id: 'ASC' } });

const manifestOf = async (requestId: number) =>
  (await getRepository(MangaRequestManifest).findOneByOrFail({ requestId }))
    .bindingState;

const requestStatusOf = async (requestId: number) =>
  (await getRepository(MediaRequest).findOneByOrFail({ id: requestId })).status;

const sorted = (values: string[]) => [...values].sort();

beforeEach(() => {
  clock = Date.now();
  searches = [];
  anilistCalls = [];
  mangadexCalls = [];
  violations = [];
  admissions = [];
  depth = 0;
  anilistReplies.clear();
  mangadexReplies.clear();
  settings.main.enabledMediaCategories = {
    ...original.categories,
    manga: true,
  };
  settings.main.mangaIncludeAdult = false;
  settings.main.mangaIncludeNovels = false;
  configure();
  mock.method(requestAdmissionCoordinator, 'run', observedRun);
  mock.method(AnilistAPI.prototype, 'getMangaDetails', async (id: number) => {
    outside('anilist');
    anilistCalls.push(id);
    const reply = anilistReplies.has(id) ? anilistReplies.get(id) : details(id);
    if (reply instanceof Error) throw reply;
    return reply ?? null;
  });
  mock.method(
    MangaDexAPI.prototype,
    'searchMangaByTitle',
    async (title: string) => {
      outside('mangadex');
      mangadexCalls.push(title);
      const reply = mangadexReplies.get(title) ?? [];
      if (reply instanceof Error) throw reply;
      return reply;
    }
  );
});

afterEach(async () => {
  mock.restoreAll();
  settings.main.enabledMediaCategories = original.categories;
  settings.main.mangaIncludeAdult = original.includeAdult;
  settings.main.mangaIncludeNovels = original.includeNovels;
  configure();
  try {
    assert.deepEqual(violations, []);
    // The source search is the resolver's only Suwayomi write.
    for (const server of servers) {
      for (const sent of server.requests) {
        assert.ok(sent.query);
        for (const definition of parse(sent.query).definitions) {
          assert.ok(definition.kind === Kind.OPERATION_DEFINITION);
          if (definition.operation !== OperationTypeNode.QUERY) {
            assert.equal(definition.name?.value, 'SearchSource');
          }
        }
      }
    }
  } finally {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  }
});

describe('manga source resolver: exact links', () => {
  it('binds an exact link that a source confirms and un-parks the request', async () => {
    const requestId = await seedRequest(T1);
    link(T1, U1);
    await serve({
      sources: [{ id: '1001' }],
      search: probeFinds(U1, exactHit(101, U1)),
    });
    admissions = [];

    await resolver().run();

    assert.deepEqual(mangadexCalls, [englishOf(T1)]);
    assert.deepEqual(searches, [`1001 id:${U1}`]);
    const [binding, ...others] = await bindings();
    assert.deepEqual(others, []);
    assert.deepEqual(
      {
        anilistId: binding.anilistId,
        sourceId: binding.sourceId,
        url: binding.url,
        urlHash: binding.urlHash,
        suwayomiMangaId: binding.suwayomiMangaId,
        title: binding.title,
        confidence: binding.confidence,
        matchedBy: binding.matchedBy,
        origin: binding.origin,
        state: binding.state,
        inLibrary: binding.inLibrary,
        availability: binding.availability,
        chapterCount: binding.chapterCount,
        downloadCount: binding.downloadCount,
      },
      {
        anilistId: T1,
        sourceId: '1001',
        url: `/manga/${U1}`,
        urlHash: hashMangaSourceUrl(`/manga/${U1}`),
        suwayomiMangaId: 101,
        title: 'Synthetic Source Title 101',
        confidence: 'EXACT_LINK',
        matchedBy: 'mangadex-link',
        origin: 'resolver',
        state: 'ACTIVE',
        inLibrary: false,
        availability: MediaStatus.UNKNOWN,
        chapterCount: null,
        downloadCount: null,
      }
    );
    assert.equal(await manifestOf(requestId), BOUND);
    assert.equal(await requestStatusOf(requestId), APPROVED);
    assert.deepEqual(await stateOf(T1), {
      status: 'BOUND',
      reason: 'EXACT_LINK',
      mangadexUuid: U1,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    assert.deepEqual(await candidatesOf(T1), []);
    // The binding takes the title's admission, then the instance's; the
    // outcome is recorded under the title's admission alone.
    const key = getMangaAdmissionKey(T1);
    assert.deepEqual(admissions, [
      { resources: [key], depth: 0 },
      { resources: ['service-config:suwayomi:1'], depth: 1 },
      { resources: [key], depth: 0 },
    ]);
  });

  it('searches for a pending request only once an admin asks', async () => {
    const requestId = await seedRequest(T1, PENDING);
    link(T1, U1);
    await serve({
      sources: [{ id: '1001' }],
      search: probeFinds(U1, exactHit(101, U1)),
    });
    const run = resolver();

    await run.run();
    assert.deepEqual([anilistCalls, mangadexCalls, searches], [[], [], []]);
    assert.equal(await resolution(T1), null);

    await requestMangaTitleSearch(1, T1);
    advance(1);
    await run.run();

    assert.deepEqual(searches, [`1001 id:${U1}`]);
    assert.equal(await requestStatusOf(requestId), PENDING);
    assert.equal(await manifestOf(requestId), BOUND);
    const row = await resolution(T1);
    assert.equal(row?.status, MangaResolutionStatus.BOUND);
    assert.equal(row?.searchRequestedAt, null);
  });

  it('offers ambiguous MangaDex links and binds none', async () => {
    const requestId = await seedRequest(T1);
    link(T1, U1, U2);
    await serve({
      sources: [{ id: '1001' }],
      search: (_sourceId, query) =>
        query === `id:${U1}`
          ? [exactHit(101, U1)]
          : query === `id:${U2}`
            ? [exactHit(102, U2)]
            : [],
    });

    await resolver().run();

    assert.deepEqual(
      sorted(searches),
      sorted([
        `1001 id:${U1}`,
        `1001 id:${U2}`,
        `1001 ${englishOf(T1)}`,
        `1001 ${romajiOf(T1)}`,
      ])
    );
    assert.deepEqual(await bindings(), []);
    assert.equal(await manifestOf(requestId), AWAITING_BINDING);
    assert.deepEqual(await stateOf(T1), {
      status: 'NEEDS_PICK',
      reason: 'MANGADEX_AMBIGUOUS',
      mangadexUuid: U1,
      attempts: 0,
      nextAttemptAt: clock + WEEK,
      lastError: null,
    });
    assert.deepEqual(
      (await candidatesOf(T1))
        .map(({ url, confidence, matchedBy, score }) =>
          [url, confidence, matchedBy, score].join(' ')
        )
        .sort(),
      [
        `/manga/${U1} EXACT_LINK mangadex-link 1000`,
        `/manga/${U2} EXACT_LINK mangadex-link 1000`,
      ]
    );
  });

  it('refuses a hit that carries another MangaDex ID', async () => {
    await seedRequest(T1);
    link(T1, U1);
    await serve({
      sources: [{ id: '1001' }],
      search: () => [exactHit(101, U2, { title: englishOf(T1) })],
    });

    await resolver().run();

    assert.deepEqual(searches, [`1001 id:${U1}`, `1001 ${englishOf(T1)}`]);
    assert.deepEqual(await bindings(), []);
    assert.deepEqual(await stateOf(T1), {
      status: 'NEEDS_PICK',
      reason: 'TITLE_MATCHES',
      mangadexUuid: U1,
      attempts: 0,
      nextAttemptAt: clock + WEEK,
      lastError: null,
    });
    assert.deepEqual(await candidatesOf(T1), [
      {
        sourceId: '1001',
        sourceName: 'Fake Source 1001',
        sourceLang: 'en',
        url: `/manga/${U2}`,
        suwayomiMangaId: 101,
        inLibrary: false,
        score: 1000,
        confidence: 'HIGH',
        matchedBy: 'title',
      },
    ]);
  });
});

describe('manga source resolver: content gate', () => {
  const sources: FakeSource[] = [
    { id: '1001', contentWarning: 'SAFE' },
    { id: '1002', contentWarning: 'NSFW' },
    { id: '1003', contentWarning: 'MIXED' },
    { id: '1004', contentWarning: 'SOMETHING_ELSE' },
  ];

  it('sends title searches only to safe sources while adult titles are off', async () => {
    await seedRequest(T1);
    await serve({ sources });

    await resolver().run();

    assert.deepEqual(searches, [
      `1001 ${englishOf(T1)}`,
      `1001 ${romajiOf(T1)}`,
    ]);
    assert.deepEqual(await stateOf(T1), {
      status: 'NO_MATCH',
      reason: 'NO_CANDIDATES',
      mangadexUuid: null,
      attempts: 1,
      nextAttemptAt: clock + HOUR,
      lastError: null,
    });
  });

  it('sends title searches to every allowlisted source while adult titles are on', async () => {
    settings.main.mangaIncludeAdult = true;
    await seedRequest(T1);
    await serve({ sources });

    await resolver().run();

    assert.deepEqual(
      sorted(searches),
      sorted(
        sources.flatMap(({ id }) => [
          `${id} ${englishOf(T1)}`,
          `${id} ${romajiOf(T1)}`,
        ])
      )
    );
  });

  it('binds an exact link through a source that is not safe', async () => {
    const requestId = await seedRequest(T1);
    link(T1, U1);
    await serve({
      sources: [{ id: '1002', contentWarning: 'NSFW' }],
      search: probeFinds(U1, exactHit(201, U1)),
    });

    await resolver().run();

    assert.deepEqual(searches, [`1002 id:${U1}`]);
    assert.deepEqual(
      (await bindings()).map(({ sourceId, origin }) => [sourceId, origin]),
      [['1002', 'resolver']]
    );
    assert.equal(await manifestOf(requestId), BOUND);
  });
});

describe('manga source resolver: content policy', () => {
  it('excludes adult and unknown titles before any search', async () => {
    await seedRequest(T1);
    await seedRequest(T2);
    anilistReplies.set(T1, details(T1, { isAdult: true }));
    anilistReplies.set(T2, null);
    await getRepository(MangaSourceCandidate).save(
      new MangaSourceCandidate({
        instanceId: 1,
        anilistId: T1,
        sourceId: '1001',
        url: '/fake-title/101',
        urlHash: hashMangaSourceUrl('/fake-title/101'),
        suwayomiMangaId: 101,
        title: 'Synthetic Stale Title',
        score: 800,
        confidence: MangaBindingConfidence.MEDIUM,
        matchedBy: 'title',
      })
    );
    const server = await serve({ sources: [{ id: '1001' }] });

    await resolver().run();

    assert.equal(server.requests.length, 0);
    assert.deepEqual(mangadexCalls, []);
    const excluded = {
      status: 'EXCLUDED',
      mangadexUuid: null,
      attempts: 0,
      nextAttemptAt: clock + DAY,
      lastError: null,
    };
    assert.deepEqual(await stateOf(T1), {
      ...excluded,
      reason: 'CONTENT_POLICY',
    });
    assert.deepEqual(await stateOf(T2), {
      ...excluded,
      reason: 'ANILIST_NOT_FOUND',
    });
    assert.deepEqual(await candidatesOf(T1), []);
  });

  it('caps novels at MEDIUM and excludes them once the policy changes', async () => {
    settings.main.mangaIncludeNovels = true;
    const requestId = await seedRequest(T1);
    anilistReplies.set(T1, details(T1, { format: 'NOVEL' }));
    await serve({
      sources: [{ id: '1001' }],
      search: () => [titleHit(101, englishOf(T1))],
    });
    const run = resolver();

    await run.run();
    assert.deepEqual(
      (await candidatesOf(T1)).map(({ confidence, score }) => [
        confidence,
        score,
      ]),
      [['MEDIUM', 1000]]
    );
    assert.equal((await stateOf(T1)).status, 'NEEDS_PICK');

    settings.main.mangaIncludeNovels = false;
    advance(WEEK);
    await run.run();

    assert.deepEqual(await stateOf(T1), {
      status: 'EXCLUDED',
      reason: 'CONTENT_POLICY',
      mangadexUuid: null,
      attempts: 0,
      nextAttemptAt: clock + DAY,
      lastError: null,
    });
    assert.deepEqual(await candidatesOf(T1), []);
    assert.equal(await requestStatusOf(requestId), APPROVED);
  });
});

describe('manga source resolver: title matches', () => {
  it('offers the best match per source and never binds one', async () => {
    const requestId = await seedRequest(T1);
    await serve({
      sources: [{ id: '1001' }, { id: '1002' }, { id: '1003' }],
      search: (sourceId) => [
        titleHit(itemId(sourceId, 1), englishOf(T1)),
        titleHit(itemId(sourceId, 2), 'Unrelated Words Entirely'),
      ],
    });

    await resolver({ candidatesPerTitle: 2 }).run();

    assert.deepEqual(
      sorted(searches),
      ['1001', '1002', '1003'].map((id) => `${id} ${englishOf(T1)}`)
    );
    assert.deepEqual(await bindings(), []);
    assert.equal(await manifestOf(requestId), AWAITING_BINDING);
    assert.deepEqual(await stateOf(T1), {
      status: 'NEEDS_PICK',
      reason: 'TITLE_MATCHES',
      mangadexUuid: null,
      attempts: 0,
      nextAttemptAt: clock + WEEK,
      lastError: null,
    });
    assert.deepEqual(
      await candidatesOf(T1),
      ['1001', '1002'].map((sourceId) => ({
        sourceId,
        sourceName: `Fake Source ${sourceId}`,
        sourceLang: 'en',
        url: `/fake-title/${itemId(sourceId, 1)}`,
        suwayomiMangaId: itemId(sourceId, 1),
        inLibrary: false,
        score: 1000,
        confidence: 'HIGH',
        matchedBy: 'title',
      }))
    );
  });
});

describe('manga source resolver: backoff', () => {
  it('waits longer after each run that finds nothing until an admin asks', async () => {
    await seedRequest(T1);
    await serve({ sources: [{ id: '1001' }] });
    const run = resolver();
    const noMatch = (attempts: number, wait: number) => ({
      status: 'NO_MATCH',
      reason: 'NO_CANDIDATES',
      mangadexUuid: null,
      attempts,
      nextAttemptAt: clock + wait,
      lastError: null,
    });

    await run.run();
    assert.deepEqual(await stateOf(T1), noMatch(1, HOUR));
    advance(HOUR / 2);
    await run.run();
    assert.equal(searches.length, 2);

    const waits = [6 * HOUR, DAY, WEEK, WEEK];
    let wait = HOUR;
    for (const [index, next] of waits.entries()) {
      advance(wait);
      await run.run();
      assert.deepEqual(await stateOf(T1), noMatch(index + 2, next));
      wait = next;
    }
    assert.equal(searches.length, 10);

    await requestMangaTitleSearch(1, T1);
    assert.deepEqual(await stateOf(T1), {
      status: 'QUEUED',
      reason: null,
      mangadexUuid: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    advance(1);
    await run.run();
    assert.equal(searches.length, 12);
    assert.deepEqual(await stateOf(T1), noMatch(1, HOUR));
    assert.equal((await resolution(T1))?.searchRequestedAt, null);
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(mangaNoMatchDelayMs), [
      HOUR,
      6 * HOUR,
      DAY,
      WEEK,
      WEEK,
      WEEK,
    ]);
  });

  it('searches a bound title again once its request waits again', async () => {
    await seedRequest(T1);
    await seedResolution(T1, {
      status: MangaResolutionStatus.BOUND,
      reason: 'EXACT_LINK',
    });
    await serve({ sources: [{ id: '1001' }] });

    await resolver().run();

    assert.equal(searches.length, 2);
    assert.equal((await stateOf(T1)).status, 'NO_MATCH');
  });

  it('retries a title that lost its binding an hour after a failed search', async () => {
    await seedRequest(T1);
    await seedResolution(T1, {
      status: MangaResolutionStatus.BOUND,
      reason: 'EXACT_LINK',
    });
    await serve({
      sources: [{ id: '1001' }],
      search: () => graphqlErrors([syntheticFailure()]),
    });
    const run = resolver();

    await run.run();
    assert.equal(searches.length, 1);
    assert.deepEqual(await stateOf(T1), {
      status: 'QUEUED',
      reason: null,
      mangadexUuid: null,
      attempts: 0,
      nextAttemptAt: clock + HOUR,
      lastError: 'SOURCE_SEARCH_FAILED',
    });

    advance(HOUR / 6);
    await run.run();
    assert.equal(searches.length, 1);

    advance(HOUR);
    await run.run();
    assert.equal(searches.length, 2);
  });
});

describe('manga source resolver: MangaDex failures', () => {
  it('defers the run on a MangaDex cooldown without growing the backoff', async () => {
    await seedRequest(T1);
    await seedRequest(T2);
    const due = new Date(clock - 1);
    await seedResolution(T1, {
      status: MangaResolutionStatus.NO_MATCH,
      reason: 'NO_CANDIDATES',
      attempts: 2,
      nextAttemptAt: due,
    });
    mangadexReplies.set(englishOf(T1), new MangaDexRateLimitedError(60, true));
    await serve({ sources: [{ id: '1001' }] });

    await resolver().run();

    assert.deepEqual(searches, []);
    assert.deepEqual(mangadexCalls, [englishOf(T1)]);
    assert.deepEqual(await stateOf(T1), {
      status: 'NO_MATCH',
      reason: 'NO_CANDIDATES',
      mangadexUuid: null,
      attempts: 2,
      nextAttemptAt: due.getTime(),
      lastError: 'MANGADEX_COOLDOWN',
    });
    assert.equal(await resolution(T2), null);
  });

  it('still searches the sources after a MangaDex failure and retries soon', async () => {
    await seedRequest(T1);
    await seedRequest(T2);
    await seedResolution(T2, {
      status: MangaResolutionStatus.NO_MATCH,
      reason: 'NO_CANDIDATES',
      attempts: 2,
      nextAttemptAt: new Date(clock - 1),
    });
    mangadexReplies.set(englishOf(T1), new MangaDexBadResponseError());
    mangadexReplies.set(englishOf(T2), new MangaDexBadResponseError());
    await serve({
      sources: [{ id: '1001' }],
      search: (_sourceId, query) =>
        query === englishOf(T1) ? [titleHit(101, englishOf(T1))] : [],
    });

    await resolver().run();

    assert.deepEqual(searches, [
      `1001 ${englishOf(T1)}`,
      `1001 ${englishOf(T2)}`,
      `1001 ${romajiOf(T2)}`,
    ]);
    assert.deepEqual(await stateOf(T1), {
      status: 'NEEDS_PICK',
      reason: 'TITLE_MATCHES',
      mangadexUuid: null,
      attempts: 0,
      nextAttemptAt: clock + HOUR,
      lastError: 'MANGADEX_FAILED',
    });
    assert.deepEqual(await stateOf(T2), {
      status: 'NO_MATCH',
      reason: 'MANGADEX_FAILED',
      mangadexUuid: null,
      attempts: 2,
      nextAttemptAt: clock + HOUR,
      lastError: 'MANGADEX_FAILED',
    });
  });
});

describe('manga source resolver: binding rules', () => {
  const needsPick = (reason: string) => ({
    status: 'NEEDS_PICK',
    reason,
    mangadexUuid: U1,
    attempts: 0,
    nextAttemptAt: clock + WEEK,
    lastError: null,
  });

  it('lets a title with an ACTIVE binding catch up without any search', async () => {
    const requestId = await seedRequest(T1);
    await seedBinding(T1, '/fake-title/701');
    const server = await serve({ sources: [{ id: '1001' }] });

    await resolver().run();

    assert.equal(server.requests.length, 0);
    assert.deepEqual([anilistCalls, mangadexCalls], [[], []]);
    assert.equal(await manifestOf(requestId), BOUND);
    assert.deepEqual(await stateOf(T1), {
      status: 'BOUND',
      reason: 'EXISTING_BINDING',
      mangadexUuid: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it('reuses the orphaned binding of the same title', async () => {
    const requestId = await seedRequest(T1);
    link(T1, U1);
    const orphan = await seedBinding(T1, `/manga/${U1}`, {
      state: MangaBindingState.ORPHANED,
    });
    await serve({
      sources: [{ id: '1001' }],
      search: probeFinds(U1, exactHit(101, U1)),
    });

    await resolver().run();

    assert.deepEqual(
      (await bindings()).map(
        ({ id, state, origin, confidence, matchedBy, inLibrary }) => ({
          id,
          state,
          origin,
          confidence,
          matchedBy,
          inLibrary,
        })
      ),
      [
        {
          id: orphan.id,
          state: 'ACTIVE',
          origin: 'resolver',
          confidence: 'EXACT_LINK',
          matchedBy: 'mangadex-link',
          inLibrary: false,
        },
      ]
    );
    assert.equal(await manifestOf(requestId), BOUND);
    assert.equal((await stateOf(T1)).reason, 'EXACT_LINK');
  });

  it('keeps an item bound to another title as a candidate', async () => {
    const requestId = await seedRequest(T1);
    link(T1, U1);
    const other = await seedBinding(OTHER_TITLE, `/manga/${U1}`, {
      confidence: MangaBindingConfidence.EXACT_LINK,
      matchedBy: 'mangadex-link',
      origin: 'resolver',
      inLibrary: false,
    });
    await serve({
      sources: [{ id: '1001' }],
      search: probeFinds(U1, exactHit(101, U1)),
    });

    await resolver().run();

    assert.deepEqual(
      (await bindings()).map(({ id, anilistId, state }) => [
        id,
        anilistId,
        state,
      ]),
      [[other.id, OTHER_TITLE, 'ACTIVE']]
    );
    assert.equal(await manifestOf(requestId), AWAITING_BINDING);
    assert.deepEqual(await stateOf(T1), needsPick('EXACT_BOUND_ELSEWHERE'));
    assert.deepEqual(
      (await candidatesOf(T1)).map(({ url, confidence }) => [url, confidence]),
      [[`/manga/${U1}`, 'EXACT_LINK']]
    );
  });

  it('never binds a pair an admin rejected', async () => {
    await seedRequest(T1);
    link(T1, U1);
    const rejected = await seedBinding(T1, `/manga/${U1}`, {
      state: MangaBindingState.REJECTED,
      inLibrary: false,
    });
    await serve({
      sources: [{ id: '1001' }],
      search: probeFinds(U1, exactHit(101, U1)),
    });

    await resolver().run();

    assert.deepEqual(
      (await bindings()).map(({ id, state }) => [id, state]),
      [[rejected.id, 'REJECTED']]
    );
    assert.deepEqual(await stateOf(T1), needsPick('EXACT_REJECTED'));
  });

  it('leaves an exact item already in the library to an admin', async () => {
    await seedRequest(T1);
    link(T1, U1);
    await serve({
      sources: [{ id: '1001' }],
      search: probeFinds(U1, exactHit(101, U1, { inLibrary: true })),
    });

    await resolver().run();

    assert.deepEqual(await bindings(), []);
    assert.deepEqual(await stateOf(T1), needsPick('EXACT_IN_LIBRARY'));
    assert.deepEqual(
      (await candidatesOf(T1)).map(({ inLibrary, confidence }) => [
        inLibrary,
        confidence,
      ]),
      [[true, 'EXACT_LINK']]
    );
  });

  it('binds only a source in a preferred language', async () => {
    await seedRequest(T1);
    link(T1, U1);
    await serve({
      sources: [{ id: '1001', lang: 'en' }],
      search: probeFinds(U1, exactHit(101, U1)),
      instance: { preferredLanguages: ['de'] },
    });

    await resolver().run();

    assert.deepEqual(await bindings(), []);
    assert.deepEqual(await stateOf(T1), needsPick('EXACT_NOT_PREFERRED'));
  });

  it('ranks exact hits by preferred language, then multi-language sources', async () => {
    for (const anilistId of [T1, T2, T3]) await seedRequest(anilistId);
    link(T1, U1);
    link(T2, U2);
    link(T3, U3);
    const serving: Record<string, [n: number, sourceIds: string[]]> = {
      [U1]: [1, ['1001', '1002', '1003', '1004']],
      [U2]: [2, ['1001', '1002']],
      [U3]: [3, ['1002', '1003']],
    };
    await serve({
      sources: [
        { id: '1001', lang: 'fr' },
        { id: '1002', lang: 'multi' },
        { id: '1003', lang: 'en' },
        { id: '1004', lang: 'de' },
      ],
      instance: { preferredLanguages: ['de', 'en'] },
      search: (sourceId, query) => {
        const [n, sourceIds] = serving[query.replace(/^id:/, '')] ?? [0, []];
        const value = query.replace(/^id:/, '');
        return sourceIds.includes(sourceId)
          ? [exactHit(itemId(sourceId, n), value)]
          : [];
      },
    });

    await resolver().run();

    assert.deepEqual(
      (await bindings()).map(({ anilistId, sourceId }) => [
        anilistId,
        sourceId,
      ]),
      [
        [T1, '1004'],
        [T2, '1002'],
        [T3, '1003'],
      ]
    );
    assert.deepEqual(
      sorted((await candidatesOf(T1)).map(({ sourceId }) => sourceId)),
      ['1001', '1002', '1003']
    );
  });
});

describe('manga source resolver: runs', () => {
  it('writes nothing once cancelled', async () => {
    await seedRequest(T1);
    const run = resolver();
    await serve({
      sources: [{ id: '1001' }],
      search: () => {
        run.cancel();
        return { hang: true };
      },
    });

    await run.run();

    assert.equal(searches.length, 1);
    assert.equal(await resolution(T1), null);
    assert.equal(run.status().running, false);
  });

  it('never inherits the async context of whoever starts it', async () => {
    await seedRequest(T1);
    await serve({ sources: [{ id: '1001' }] });
    const route = new AsyncLocalStorage<string>();
    const contexts: (string | undefined)[] = [];
    const traced: typeof requestAdmissionCoordinator.run = (
      resources,
      callback
    ) => {
      contexts.push(route.getStore());
      return observedRun(resources, callback);
    };
    mock.method(requestAdmissionCoordinator, 'run', traced);

    await route.run('route admission', () => resolver().run());

    assert.equal((await stateOf(T1)).status, 'NO_MATCH');
    assert.ok(contexts.length > 0);
    assert.deepEqual([...new Set(contexts)], [undefined]);
  });

  it('ignores a run while another is going', async () => {
    await seedRequest(T1);
    await serve({ sources: [{ id: '1001' }] });
    const run = resolver();

    const first = run.run();
    assert.equal(run.status().running, true);
    await run.run();
    await first;

    assert.equal(run.status().running, false);
    assert.deepEqual(anilistCalls, [T1]);
    assert.equal(searches.length, 2);
  });

  it('stops an instance before a title could pass the search budget', async () => {
    for (const anilistId of [T1, T2, T3]) await seedRequest(anilistId);
    await serve({ sources: [{ id: '1001' }] });

    await resolver({ searchesPerInstance: 7 }).run();

    // Each title may take 3 probes and 2 title searches; the third would
    // pass the budget after the first two took 4.
    assert.equal(searches.length, 4);
    assert.equal((await stateOf(T2)).attempts, 1);
    assert.equal(await resolution(T3), null);
  });

  it('stops after the titles a run may take', async () => {
    for (const anilistId of [T1, T2, T3]) await seedRequest(anilistId);
    await serve({ sources: [{ id: '1001' }] });

    await resolver({ titlesPerRun: 2 }).run();

    assert.deepEqual(anilistCalls, [T1, T2]);
    assert.equal(searches.length, 4);
    assert.equal(await resolution(T3), null);
  });

  it('does nothing without an instance or with the manga category off', async () => {
    await seedRequest(T1);
    await resolver().run();
    assert.deepEqual(anilistCalls, []);

    const server = await serve({ sources: [{ id: '1001' }] });
    settings.main.enabledMediaCategories = {
      ...original.categories,
      manga: false,
    };
    await resolver().run();

    assert.equal(server.requests.length, 0);
    assert.deepEqual(anilistCalls, []);
    assert.equal(await resolution(T1), null);
  });
});

describe('manga source resolver: failures', () => {
  const unavailable = {
    status: 'QUEUED',
    reason: null,
    mangadexUuid: null,
    attempts: 0,
    nextAttemptAt: null,
    lastError: 'SUWAYOMI_UNAVAILABLE',
  };

  it('ends the run for an unsupported server', async () => {
    await seedRequest(T1);
    await seedRequest(T2);
    await serve({
      sources: [{ id: '1001' }],
      capabilities: capabilitiesData({ queryFields: [] }),
    });

    await resolver().run();

    assert.deepEqual(searches, []);
    assert.deepEqual(await stateOf(T1), unavailable);
    assert.equal(await resolution(T2), null);
  });

  it('ends the run for the instance on an auth failure', async () => {
    await seedRequest(T1);
    await seedRequest(T2);
    await serve({ sources: [{ id: '1001' }], search: () => ({ status: 403 }) });

    await resolver().run();

    assert.equal(searches.length, 1);
    assert.deepEqual(await stateOf(T1), unavailable);
    assert.equal(await resolution(T2), null);
  });

  it('offers what an incomplete search found and retries within an hour', async () => {
    await seedRequest(T1);
    await serve({
      sources: [{ id: '1001' }, { id: '1002' }],
      search: (sourceId, query) =>
        sourceId === '1001'
          ? graphqlErrors([syntheticFailure()])
          : query === englishOf(T1)
            ? [titleHit(201, englishOf(T1))]
            : [],
    });

    await resolver().run();

    assert.deepEqual(await stateOf(T1), {
      status: 'NEEDS_PICK',
      reason: 'TITLE_MATCHES',
      mangadexUuid: null,
      attempts: 0,
      nextAttemptAt: clock + HOUR,
      lastError: 'SOURCE_SEARCH_FAILED',
    });
    assert.deepEqual(
      (await candidatesOf(T1)).map(({ sourceId }) => sourceId),
      ['1002']
    );
  });

  it('keeps the backoff when a source fails and the others find nothing', async () => {
    await seedRequest(T1);
    await seedResolution(T1, {
      status: MangaResolutionStatus.NO_MATCH,
      reason: 'NO_CANDIDATES',
      attempts: 2,
      nextAttemptAt: new Date(clock - 1),
    });
    await serve({
      sources: [{ id: '1001' }, { id: '1002' }],
      search: (sourceId) =>
        sourceId === '1001' ? graphqlErrors([syntheticFailure()]) : [],
    });

    await resolver().run();

    assert.deepEqual(
      sorted(searches),
      sorted([
        `1001 ${englishOf(T1)}`,
        `1002 ${englishOf(T1)}`,
        `1002 ${romajiOf(T1)}`,
      ])
    );
    assert.deepEqual(await stateOf(T1), {
      status: 'NO_MATCH',
      reason: 'NO_CANDIDATES',
      mangadexUuid: null,
      attempts: 2,
      nextAttemptAt: clock + HOUR,
      lastError: 'SOURCE_SEARCH_FAILED',
    });
  });

  it('keeps the status and the backoff when no source answers', async () => {
    await seedRequest(T1);
    await serve({
      sources: [{ id: '1001' }],
      search: () => graphqlErrors([syntheticFailure()]),
    });

    await resolver().run();

    assert.equal(searches.length, 1);
    assert.deepEqual(await stateOf(T1), {
      status: 'QUEUED',
      reason: null,
      mangadexUuid: null,
      attempts: 0,
      nextAttemptAt: clock + HOUR,
      lastError: 'SOURCE_SEARCH_FAILED',
    });
  });

  it('puts a title on the normal ladder when the content gate leaves no source', async () => {
    await seedRequest(T1);
    await serve({ sources: [{ id: '1002', contentWarning: 'NSFW' }] });

    await resolver().run();

    assert.deepEqual(searches, []);
    assert.deepEqual(await stateOf(T1), {
      status: 'NO_MATCH',
      reason: 'NO_ELIGIBLE_SOURCES',
      mangadexUuid: null,
      attempts: 1,
      nextAttemptAt: clock + HOUR,
      lastError: null,
    });
  });

  it('puts a title on the normal ladder when no allowlisted source is installed', async () => {
    await seedRequest(T1);
    await serve({
      sources: [{ id: '1001' }],
      instance: { sourceAllowlist: ['1005'] },
    });

    await resolver().run();

    assert.deepEqual(searches, []);
    assert.deepEqual(mangadexCalls, []);
    assert.deepEqual(await stateOf(T1), {
      status: 'NO_MATCH',
      reason: 'NO_ELIGIBLE_SOURCES',
      mangadexUuid: null,
      attempts: 1,
      nextAttemptAt: clock + HOUR,
      lastError: null,
    });
  });

  it('stops the run on an AniList rate limit', async () => {
    await seedRequest(T1);
    await seedRequest(T2);
    anilistReplies.set(T1, new AnilistRateLimitedError(30));
    const server = await serve({ sources: [{ id: '1001' }] });

    await resolver().run();

    assert.equal(server.requests.length, 0);
    assert.deepEqual(anilistCalls, [T1]);
    assert.deepEqual(await stateOf(T1), {
      ...unavailable,
      lastError: 'ANILIST_RATE_LIMITED',
    });
    assert.equal(await resolution(T2), null);
  });

  it('stops the run on an AniList outage and retries the title soon', async () => {
    await seedRequest(T1);
    await seedRequest(T2);
    anilistReplies.set(T1, new AnilistOutageError());
    await serve({ sources: [{ id: '1001' }] });

    await resolver().run();

    assert.deepEqual(anilistCalls, [T1]);
    assert.deepEqual(await stateOf(T1), {
      ...unavailable,
      nextAttemptAt: clock + HOUR,
      lastError: 'ANILIST_FAILED',
    });
    assert.equal(await resolution(T2), null);
  });

  it('goes on with the next title after another AniList failure', async () => {
    await seedRequest(T1);
    await seedRequest(T2);
    anilistReplies.set(T1, new Error('synthetic failure'));
    await serve({ sources: [{ id: '1001' }] });

    await resolver().run();

    assert.deepEqual(await stateOf(T1), {
      ...unavailable,
      nextAttemptAt: clock + HOUR,
      lastError: 'ANILIST_FAILED',
    });
    assert.equal((await stateOf(T2)).status, 'NO_MATCH');
  });
});

describe('manga source resolver: probe memory', () => {
  const probes = () => searches.filter((entry) => entry.includes(' id:'));

  it('probes a source that missed again only after a week', async () => {
    await seedRequest(T1);
    link(T1, U1);
    await serve({ sources: [{ id: '1001' }] });
    const run = resolver();

    await run.run();
    assert.deepEqual(probes(), [`1001 id:${U1}`]);

    advance(HOUR);
    await run.run();
    assert.equal((await stateOf(T1)).attempts, 2);
    assert.deepEqual(probes(), [`1001 id:${U1}`]);

    advance(WEEK);
    await run.run();
    assert.deepEqual(probes(), [`1001 id:${U1}`, `1001 id:${U1}`]);
  });

  it('probes only a source that answered for the next title', async () => {
    await seedRequest(T1);
    await seedRequest(T2);
    link(T1, U1);
    link(T2, U2);
    await serve({
      sources: [{ id: '1001' }, { id: '1002' }],
      search: (sourceId, query) =>
        sourceId === '1002' && query.startsWith('id:')
          ? [
              exactHit(
                itemId(sourceId, query.endsWith(U1) ? 1 : 2),
                query.slice(3)
              ),
            ]
          : [],
    });

    await resolver().run();

    assert.deepEqual(
      sorted(searches),
      sorted([`1001 id:${U1}`, `1002 id:${U1}`, `1002 id:${U2}`])
    );
    assert.deepEqual(
      (await bindings()).map(({ anilistId, sourceId }) => [
        anilistId,
        sourceId,
      ]),
      [
        [T1, '1002'],
        [T2, '1002'],
      ]
    );
  });
});

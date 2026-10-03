import AnilistAPI from '@server/api/anilist';
import type { AnilistMangaSummary } from '@server/api/anilist/manga';
import MangaDexAPI from '@server/api/mangadex';
import { SUWAYOMI_TRACKER_IDS } from '@server/api/suwayomi';
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
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { User } from '@server/entity/User';
import type { MangaLibraryItemState } from '@server/interfaces/api/mangaLibraryInterfaces';
import { createMangaMedia } from '@server/lib/mangaMedia';
import { mangaLibraryScanner } from '@server/lib/scanners/manga/suwayomi';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import logger from '@server/logger';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  capabilitiesData,
  fakeLibraryManga,
  fakeMangaDetailsNode,
  graphqlData,
  serveFakeLibrary,
  startFakeSuwayomi,
  type FakeLibrary,
  type FakeLibraryManga,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import { Kind, OperationTypeNode, parse } from 'graphql';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';
import router from './index';

setupTestDb();

const BASE = '/api/v1/manga/library';
type Query = Record<string, string | number>;
const PASSWORD = randomUUID();
const { AVAILABLE, PARTIALLY_AVAILABLE, UNKNOWN } = MediaStatus;
const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const servers: FakeSuwayomi[] = [];
/** Review responses that break the API spec. */
const responseErrors: string[] = [];

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    // Test-only session middleware has no network listener or real secret.
    // codeql[js/clear-text-cookie]
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateResponses: {
        onError: (error, body, req) => {
          // The guards and the error handler send the generic error body.
          const generic =
            typeof body === 'object' && body !== null && 'status' in body;
          if (req.originalUrl.startsWith(BASE) && !generic) {
            responseErrors.push(`${req.method} ${req.path}: ${error.message}`);
          }
        },
      },
      validateSecurity: false,
    })
  );
  app.use('/api/v1', router);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) =>
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message })
  );
  return app;
};

const app = createApp();

const loginAs = async (email: string) => {
  const localLogin = settings.main.localLogin;
  settings.main.localLogin = true;
  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/v1/auth/local')
      .send({ email, password: 'test1234' });
    assert.equal(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = localLogin;
  }
};
const asAdmin = () => loginAs('admin@seerr.dev');

const instanceFor = (server: FakeSuwayomi): SuwayomiSettings => {
  const url = new URL(server.url);
  return {
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
    sourceAllowlist: [],
    preferredLanguages: [],
    scanlatorPreference: [],
    requireCbz: true,
  };
};

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

/** Serves `library` from a fake server configured as instance 1. */
const serve = async (library: FakeLibrary) => {
  const server = await startFakeSuwayomi({
    mode: 'NONE',
    username: 'fake-user',
    password: PASSWORD,
  });
  serveFakeLibrary(server, library);
  servers.push(server);
  configure(instanceFor(server));
  return server;
};

const itemKey = ({ sourceId, url }: FakeLibraryManga) => ({
  instanceId: 1,
  sourceId,
  url,
});

const seedCandidate = (
  manga: FakeLibraryManga,
  proposal?: [
    anilistId: number,
    confidence: MangaBindingConfidence,
    score: number,
  ]
) =>
  getRepository(MangaMatchCandidate).save(
    new MangaMatchCandidate({
      ...itemKey(manga),
      urlHash: hashMangaSourceUrl(manga.url),
      suwayomiMangaId: manga.id,
      title: manga.title,
      ...(proposal && {
        proposedAnilistId: proposal[0],
        proposalConfidence: proposal[1],
        proposalScore: proposal[2],
        titleCheckedAt: new Date(),
      }),
    })
  );

/** A scan's tracker binding, by default. */
const seedBinding = (
  manga: FakeLibraryManga,
  anilistId: number,
  overrides: Partial<MangaSourceBinding> = {}
) =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      ...itemKey(manga),
      urlHash: hashMangaSourceUrl(manga.url),
      anilistId,
      suwayomiMangaId: manga.id,
      title: manga.title,
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state: MangaBindingState.ACTIVE,
      inLibrary: true,
      availability: AVAILABLE,
      chapterCount: 1,
      downloadCount: 1,
      ...overrides,
    })
  );

const bindings = () =>
  getRepository(MangaSourceBinding).find({ order: { id: 'ASC' } });

const candidates = () =>
  getRepository(MangaMatchCandidate).find({ order: { id: 'ASC' } });

const pairs = async () =>
  (await bindings()).map((binding) => [
    binding.anilistId,
    binding.state,
    binding.confidence,
    binding.matchedBy,
    binding.origin,
  ]);

const SCANNED_201 = [
  201,
  'ACTIVE',
  'TRACKER_LINK',
  'anilist-tracker',
  'library-scan',
];

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

const anilistManga = (id: number, romaji: string): AnilistMangaSummary => ({
  id,
  titles: { romaji },
  synonyms: [],
  isAdult: false,
  genres: [],
});

/** No scan lookup leaves a test; by default every lookup finds nothing. */
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
    async (): Promise<AnilistMangaSummary[]> => []
  ),
});
let lookups: ReturnType<typeof stubLookups>;

const scan = () => mangaLibraryScanner.run();

const itemState = (res: { body: unknown }) => res.body as MangaLibraryItemState;

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  configure();
  lookups = stubLookups();
});

afterEach(async () => {
  mock.restoreAll();
  settings.main.enabledMediaCategories = categories;
  configure();
  try {
    // No review decision and no scan changes anything on Suwayomi.
    for (const server of servers) {
      for (const sent of server.requests) {
        assert.ok(sent.query);
        for (const definition of parse(sent.query).definitions) {
          assert.equal(definition.kind, Kind.OPERATION_DEFINITION);
          assert.equal(definition.operation, OperationTypeNode.QUERY);
        }
      }
    }
    assert.deepEqual(responseErrors, []);
  } finally {
    responseErrors.length = 0;
    await Promise.all(servers.splice(0).map((server) => server.close()));
  }
});

describe('manga library review: lists', () => {
  it('pages and filters the candidates', async () => {
    const [one, two, three] = [1, 2, 3].map((id) => fakeLibraryManga(id));
    await seedCandidate(one, [201, MangaBindingConfidence.HIGH, 960]);
    await seedCandidate(two, [202, MangaBindingConfidence.LOW, 610]);
    await seedCandidate(three);
    const agent = await asAdmin();
    const list = (query: Query) => agent.get(`${BASE}/candidates`).query(query);
    const ids = async (query: Query) =>
      (await list(query)).body.results.map(
        (candidate: { suwayomiMangaId: number }) => candidate.suwayomiMangaId
      );

    const first = await list({ take: 2 });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.pageInfo, {
      page: 1,
      pages: 2,
      pageSize: 2,
      results: 3,
    });
    assert.deepEqual(first.body.results[0].proposal, {
      anilistId: 201,
      confidence: 'HIGH',
      score: 0.96,
    });
    assert.equal(first.body.results[0].title, one.title);
    const second = await list({ take: 2, skip: 2 });
    assert.equal(second.body.pageInfo.page, 2);
    assert.equal(second.body.results[0].proposal, null);

    assert.deepEqual(await ids({ take: 2 }), [1, 2]);
    assert.deepEqual(await ids({ confidence: 'NONE' }), [3]);
    assert.deepEqual(await ids({ confidence: 'LOW' }), [2]);
    assert.deepEqual(await ids({ instanceId: 1, confidence: 'HIGH' }), [1]);
    assert.deepEqual(await ids({ instanceId: 2 }), []);
    assert.equal((await list({})).body.pageInfo.pageSize, 20);
    const invalid: Query[] = [
      { take: 0 },
      { take: 101 },
      { skip: -1 },
      { confidence: 'EXACT_LINK' },
      { unknown: 1 },
    ];
    for (const query of invalid) {
      assert.equal((await list(query)).status, 400);
    }
  });

  it('pages and filters the bindings', async () => {
    const [one, two] = [1, 2].map((id) => fakeLibraryManga(id));
    await seedBinding(one, 301);
    await seedBinding(one, 302, {
      state: MangaBindingState.REJECTED,
      inLibrary: false,
    });
    await seedBinding(two, 303, {
      state: MangaBindingState.ORPHANED,
      inLibrary: false,
      chapterCount: null,
      downloadCount: null,
      availability: UNKNOWN,
    });
    const agent = await asAdmin();
    const list = (query: Query) => agent.get(`${BASE}/bindings`).query(query);
    const ids = async (query: Query) => {
      const res = await list(query);
      assert.equal(res.status, 200);
      return res.body.results.map(
        (binding: { anilistId: number }) => binding.anilistId
      );
    };

    assert.deepEqual(await ids({}), [301, 302, 303]);
    assert.deepEqual(await ids({ take: 1, skip: 1 }), [302]);
    assert.deepEqual(await ids({ state: 'REJECTED' }), [302]);
    assert.deepEqual(await ids({ state: 'ORPHANED' }), [303]);
    assert.deepEqual(await ids({ anilistId: 301 }), [301]);
    assert.deepEqual(await ids({ instanceId: 2 }), []);
    assert.deepEqual((await list({ take: 2 })).body.pageInfo, {
      page: 1,
      pages: 2,
      pageSize: 2,
      results: 3,
    });
    const invalid: Query[] = [
      { state: 'LIVE' },
      { anilistId: 0 },
      { take: 'x' },
    ];
    for (const query of invalid) {
      assert.equal((await list(query)).status, 400);
    }
  });

  it('is admin-only and hidden while the manga category is off', async () => {
    const manga = fakeLibraryManga(1);
    await serve({ mangas: [manga] });
    const candidate = await seedCandidate(manga, [
      201,
      MangaBindingConfidence.HIGH,
      960,
    ]);
    const decisions = (agent: ReturnType<typeof request.agent>) => [
      () => agent.get(`${BASE}/candidates`),
      () => agent.get(`${BASE}/bindings`),
      () =>
        agent
          .post(`${BASE}/candidates/${candidate.id}/confirm`)
          .send({ anilistId: 201 }),
      () =>
        agent
          .post(`${BASE}/bind`)
          .send({ instanceId: 1, anilistId: 201, suwayomiMangaId: 1 }),
      () =>
        agent
          .post(`${BASE}/reject`)
          .send({ ...itemKey(manga), anilistId: 201 }),
    ];
    // One request at a time: supertest closes an agent's server when the
    // request that opened it ends, which can reset requests still in flight.
    const statuses = async (agent: ReturnType<typeof request.agent>) => {
      const sent: number[] = [];
      for (const decide of decisions(agent)) {
        sent.push((await decide()).status);
      }
      return sent;
    };

    const friend = await loginAs('friend@seerr.dev');
    assert.deepEqual(await statuses(friend), [403, 403, 403, 403, 403]);
    assert.equal((await request(app).get(`${BASE}/candidates`)).status, 403);

    const admin = await asAdmin();
    settings.main.enabledMediaCategories = { ...categories, manga: false };
    assert.deepEqual(await statuses(admin), [404, 404, 404, 404, 404]);
    assert.deepEqual(await bindings(), []);
    assert.equal((await candidates())[0].proposedAnilistId, 201);
    assert.deepEqual(servers[0].requests, []);
  });
});

describe('manga library review: confirm and bind', () => {
  it('confirms a title proposal and raises the media', async () => {
    const manga = fakeLibraryManga(1, { chapterCount: 2, downloadCount: 2 });
    await serve({ mangas: [manga] });
    const candidate = await seedCandidate(manga, [
      201,
      MangaBindingConfidence.MEDIUM,
      810,
    ]);
    const agent = await asAdmin();

    const res = await agent
      .post(`${BASE}/candidates/${candidate.id}/confirm`)
      .send({ anilistId: 201 });

    assert.equal(res.status, 200);
    const { binding, candidate: left } = itemState(res);
    assert.equal(left, null);
    assert.equal(binding?.anilistId, 201);
    assert.equal(binding?.confidence, 'MEDIUM');
    assert.equal(binding?.matchedBy, 'title');
    assert.equal(binding?.origin, 'admin');
    assert.equal(binding?.availability, AVAILABLE);
    assert.equal(binding?.chapterCount, 2);
    assert.deepEqual(await candidates(), []);
    assert.equal(await mediaStatus(201), AVAILABLE);
  });

  it('refuses a stale confirm and writes nothing', async () => {
    const manga = fakeLibraryManga(1, { chapterCount: 1, downloadCount: 1 });
    const server = await serve({ mangas: [manga] });
    const candidate = await seedCandidate(manga, [
      201,
      MangaBindingConfidence.HIGH,
      960,
    ]);
    const agent = await asAdmin();
    const confirm = async (id: number, anilistId: number, status: number) => {
      const res = await agent
        .post(`${BASE}/candidates/${id}/confirm`)
        .send({ anilistId });
      assert.equal(res.status, status);
      return res.body.code;
    };
    const found = graphqlData({
      mangas: { nodes: [fakeMangaDetailsNode(manga, true)] },
    });

    assert.equal(
      await confirm(candidate.id, 202, 409),
      'MANGA_PROPOSAL_CHANGED'
    );
    assert.equal(
      await confirm(candidate.id + 1, 201, 404),
      'MANGA_CANDIDATE_NOT_FOUND'
    );
    assert.equal(await confirm(0, 201, 400), undefined);
    assert.equal(server.operations('ByNaturalKey').length, 0);

    // A scan replaces the proposal while the manga is read.
    server.onOperation('ByNaturalKey', async () => {
      await getRepository(MangaMatchCandidate).update(candidate.id, {
        proposedAnilistId: 203,
      });
      return found;
    });
    assert.equal(
      await confirm(candidate.id, 201, 409),
      'MANGA_PROPOSAL_CHANGED'
    );

    // A scan binds the manga while it is read, which ends its review.
    await getRepository(MangaMatchCandidate).update(candidate.id, {
      proposedAnilistId: 201,
    });
    server.onOperation('ByNaturalKey', async () => {
      await getRepository(MangaMatchCandidate).delete(candidate.id);
      await seedBinding(manga, 201);
      return found;
    });
    assert.equal(
      await confirm(candidate.id, 201, 404),
      'MANGA_CANDIDATE_NOT_FOUND'
    );
    assert.deepEqual(await pairs(), [SCANNED_201]);
    assert.equal(await mediaStatus(201), undefined);
  });

  it('binds by Suwayomi ID or by source key, as a manual decision', async () => {
    const manga = fakeLibraryManga(1, { chapterCount: 2, downloadCount: 1 });
    await serve({ mangas: [manga] });
    await seedCandidate(manga, [201, MangaBindingConfidence.LOW, 600]);
    const agent = await asAdmin();
    const logs: unknown[] = [];
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      mock.method(logger, level, (...args: unknown[]) => {
        logs.push(args);
        return logger;
      });
    }

    const byId = await agent
      .post(`${BASE}/bind`)
      .send({ instanceId: 1, anilistId: 205, suwayomiMangaId: 1 });
    assert.equal(byId.status, 200);
    const { binding, candidate } = itemState(byId);
    assert.equal(candidate, null);
    assert.equal(binding?.anilistId, 205);
    assert.equal(binding?.confidence, 'MANUAL');
    assert.equal(binding?.matchedBy, 'manual');
    assert.equal(binding?.origin, 'admin');
    assert.equal(binding?.availability, PARTIALLY_AVAILABLE);
    assert.equal(await mediaStatus(205), PARTIALLY_AVAILABLE);

    const byKey = await agent
      .post(`${BASE}/bind`)
      .send({ ...itemKey(manga), anilistId: 205 });
    assert.equal(byKey.status, 200);
    assert.equal(itemState(byKey).binding?.id, binding?.id);
    assert.deepEqual(await pairs(), [
      [205, 'ACTIVE', 'MANUAL', 'manual', 'admin'],
    ]);
    assert.ok(logs.length > 0);
    const logged = JSON.stringify(logs);
    assert.ok(!logged.includes(manga.title));
    assert.ok(!logged.includes(manga.url));
  });

  it('refuses a bind when a scan bound the manga meanwhile', async () => {
    const manga = fakeLibraryManga(1, { chapterCount: 1, downloadCount: 1 });
    await serve({ mangas: [manga] });
    const agent = await asAdmin();
    const transaction = dataSource.transaction;
    let seeded = false;
    // The scan writes between the bind's reads and its transaction.
    mock.method(dataSource, 'transaction', async (...args: unknown[]) => {
      if (!seeded) {
        seeded = true;
        await seedBinding(manga, 201);
      }
      return Reflect.apply(transaction, dataSource, args);
    });

    const res = await agent
      .post(`${BASE}/bind`)
      .send({ instanceId: 1, anilistId: 202, suwayomiMangaId: 1 });

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'MANGA_ITEM_CHANGED');
    assert.deepEqual(await pairs(), [SCANNED_201]);
    assert.equal(await mediaStatus(202), undefined);
  });

  it('rebinding rejects the old binding, and a scan keeps the new one', async () => {
    const manga = fakeLibraryManga(1, {
      chapterCount: 1,
      downloadCount: 1,
      trackRecords: [
        { trackerId: SUWAYOMI_TRACKER_IDS.aniList, remoteId: '201' },
      ],
    });
    await serve({ mangas: [manga] });
    await scan();
    assert.deepEqual(await pairs(), [SCANNED_201]);
    assert.equal(await mediaStatus(201), AVAILABLE);
    const agent = await asAdmin();

    const res = await agent
      .post(`${BASE}/bind`)
      .send({ instanceId: 1, anilistId: 202, suwayomiMangaId: 1 });

    assert.equal(res.status, 200);
    const expected = [
      [201, 'REJECTED', 'TRACKER_LINK', 'anilist-tracker', 'library-scan'],
      [202, 'ACTIVE', 'MANUAL', 'manual', 'admin'],
    ];
    assert.deepEqual(await pairs(), expected);
    assert.equal(await mediaStatus(201), UNKNOWN);
    assert.equal(await mediaStatus(202), AVAILABLE);

    // The tracker record still names 201, but an admin's decision stays.
    await scan();
    assert.deepEqual(await pairs(), expected);
    assert.deepEqual(await candidates(), []);
    assert.equal(await mediaStatus(201), UNKNOWN);
    assert.equal(await mediaStatus(202), AVAILABLE);
  });

  it('refuses manga it cannot bind and writes nothing', async () => {
    const outside = fakeLibraryManga(9);
    const server = await serve({
      mangas: [fakeLibraryManga(1)],
      outside: [outside],
    });
    const agent = await asAdmin();
    const bind = (body: object) =>
      agent
        .post(`${BASE}/bind`)
        .send({ instanceId: 1, anilistId: 201, ...body });

    for (const [body, status, code] of [
      [{ suwayomiMangaId: 9 }, 409, 'MANGA_NOT_IN_LIBRARY'],
      [itemKey(outside), 409, 'MANGA_NOT_IN_LIBRARY'],
      [{ suwayomiMangaId: 404 }, 404, 'MANGA_ITEM_NOT_FOUND'],
      [
        { sourceId: '0', url: '/fake-library/404' },
        404,
        'MANGA_ITEM_NOT_FOUND',
      ],
      [{ instanceId: 7, suwayomiMangaId: 1 }, 404, 'MANGA_INSTANCE_NOT_FOUND'],
      // Checks the API schema cannot express.
      [
        { sourceId: '9223372036854775808', url: '/fake-library/1' },
        400,
        'MANGA_INVALID_REQUEST',
      ],
      [
        { sourceId: '0', url: '/fake-library/\u0001' },
        400,
        'MANGA_INVALID_REQUEST',
      ],
    ] as const) {
      const res = await bind(body);
      assert.equal(res.status, status, code);
      assert.equal(res.body.code, code);
    }
    for (const body of [
      { suwayomiMangaId: 0 },
      { suwayomiMangaId: 1, sourceId: '0', url: '/fake-library/1' },
      { sourceId: 'not-a-number', url: '/fake-library/1' },
      { sourceId: '0', url: '' },
    ]) {
      assert.equal((await bind(body)).status, 400);
    }

    server.onOperation('MangaDetails', graphqlData({ manga: 'not a manga' }));
    const failed = await bind({ suwayomiMangaId: 1 });
    assert.equal(failed.status, 502);
    assert.deepEqual(failed.body, {
      code: 'MANGA_SUWAYOMI_LOOKUP_FAILED',
      message: 'The Suwayomi lookup failed.',
      suwayomiCode: 'BAD_RESPONSE',
    });

    configure(instanceFor(server));
    server.onOperation('Capabilities', capabilitiesData({ queryFields: [] }));
    const unsupported = await bind({ suwayomiMangaId: 1 });
    assert.equal(unsupported.status, 409);
    assert.equal(unsupported.body.code, 'MANGA_UNSUPPORTED_SERVER');
    assert.deepEqual(await bindings(), []);
    assert.equal(await mediaStatus(201), undefined);
  });
});

describe('manga library review: reject', () => {
  it('rejects a proposal, and a rescan never proposes it again', async () => {
    const manga = fakeLibraryManga(1, { chapterCount: 1 });
    await serve({ mangas: [manga] });
    lookups.titles.mock.mockImplementation(async () => [
      anilistManga(201, manga.title),
    ]);
    await scan();
    const [scanned] = await candidates();
    assert.equal(scanned.proposedAnilistId, 201);
    assert.equal(scanned.proposalConfidence, 'HIGH');
    const agent = await asAdmin();
    const reject = () =>
      agent.post(`${BASE}/reject`).send({ ...itemKey(manga), anilistId: 201 });

    const res = await reject();

    assert.equal(res.status, 200);
    assert.equal(itemState(res).binding, null);
    assert.equal(itemState(res).candidate?.proposal, null);
    assert.deepEqual(await pairs(), [
      [201, 'REJECTED', 'MANUAL', 'manual', 'admin'],
    ]);
    await scan();
    assert.equal(lookups.titles.mock.callCount(), 2);
    const [rescanned] = await candidates();
    assert.equal(rescanned.proposedAnilistId, null);
    assert.notEqual(rescanned.titleCheckedAt, null);
    assert.equal(await mediaStatus(201), undefined);

    const again = await reject();
    assert.equal(again.status, 200);
    assert.equal((await bindings()).length, 1);
  });

  it('rejecting the live binding returns the manga to review', async () => {
    const manga = fakeLibraryManga(1, { chapterCount: 1, downloadCount: 1 });
    const server = await serve({ mangas: [manga] });
    await seedBinding(manga, 201);
    await dataSource.transaction((manager) =>
      createMangaMedia(manager, 201, AVAILABLE)
    );
    const agent = await asAdmin();

    const res = await agent
      .post(`${BASE}/reject`)
      .send({ ...itemKey(manga), anilistId: 201 });

    assert.equal(res.status, 200);
    const { binding, candidate } = itemState(res);
    assert.equal(binding, null);
    assert.equal(candidate?.suwayomiMangaId, 1);
    assert.equal(candidate?.title, manga.title);
    assert.equal(candidate?.proposal, null);
    assert.deepEqual(await pairs(), [
      [201, 'REJECTED', 'TRACKER_LINK', 'anilist-tracker', 'library-scan'],
    ]);
    assert.equal(await mediaStatus(201), UNKNOWN);
    // Rejecting reads nothing from Suwayomi.
    assert.deepEqual(server.requests, []);

    // A manual bind can restore a rejected pair.
    const restored = await agent
      .post(`${BASE}/bind`)
      .send({ ...itemKey(manga), anilistId: 201 });
    assert.equal(restored.status, 200);
    assert.deepEqual(await pairs(), [
      [201, 'ACTIVE', 'MANUAL', 'manual', 'admin'],
    ]);
    assert.deepEqual(await candidates(), []);
    assert.equal(await mediaStatus(201), AVAILABLE);
  });

  it('needs a known instance and manga', async () => {
    const agent = await asAdmin();
    const reject = (body: object = {}) =>
      agent.post(`${BASE}/reject`).send({
        ...itemKey(fakeLibraryManga(1)),
        anilistId: 201,
        ...body,
      });

    const unknown = await reject();
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'MANGA_INSTANCE_NOT_FOUND');
    await serve({ mangas: [] });
    const missing = await reject();
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'MANGA_ITEM_NOT_FOUND');
    assert.equal((await reject({ anilistId: 0 })).status, 400);
    assert.equal((await reject({ extra: true })).status, 400);
    assert.deepEqual(await bindings(), []);
  });
});

describe('manga library review: requests', () => {
  /** A pending manga request on instance 1, parked as the flow records it. */
  const recordRequest = async (anilistId: number) => {
    const media = await dataSource.transaction((manager) =>
      createMangaMedia(manager, anilistId, MediaStatus.PENDING)
    );
    const saved = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MANGA,
        media,
        requestedBy: await getRepository(User).findOneByOrFail({ id: 1 }),
        status: MediaRequestStatus.PENDING,
        is4k: false,
        serverId: 1,
      })
    );
    await getRepository(MangaRequestManifest).insert({
      requestId: saved.id,
      anilistId,
      instanceId: 1,
    });
    return saved.id;
  };

  const requestStates = async () =>
    (
      await getRepository(MangaRequestManifest).find({ order: { id: 'ASC' } })
    ).map(({ anilistId, bindingState }) => [anilistId, bindingState]);

  it('releases a parked request when its title is bound and parks it when the binding goes', async () => {
    const manga = fakeLibraryManga(1, { chapterCount: 1, downloadCount: 1 });
    await serve({ mangas: [manga] });
    await recordRequest(201);
    await recordRequest(202);
    const agent = await asAdmin();

    const bound = await agent
      .post(`${BASE}/bind`)
      .send({ instanceId: 1, anilistId: 201, suwayomiMangaId: 1 });
    assert.equal(bound.status, 200);
    assert.deepEqual(await requestStates(), [
      [201, 'BOUND'],
      [202, 'AWAITING_BINDING'],
    ]);

    // Rebinding demotes 201: its request is parked and 202's released.
    const rebound = await agent
      .post(`${BASE}/bind`)
      .send({ instanceId: 1, anilistId: 202, suwayomiMangaId: 1 });
    assert.equal(rebound.status, 200);
    assert.deepEqual(await requestStates(), [
      [201, 'AWAITING_BINDING'],
      [202, 'BOUND'],
    ]);

    const rejected = await agent
      .post(`${BASE}/reject`)
      .send({ ...itemKey(manga), anilistId: 202 });
    assert.equal(rejected.status, 200);
    assert.deepEqual(await requestStates(), [
      [201, 'AWAITING_BINDING'],
      [202, 'AWAITING_BINDING'],
    ]);
    assert.equal(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('queues an approved request for dispatch once a bind releases it', async () => {
    const manga = fakeLibraryManga(1, { chapterCount: 1, downloadCount: 1 });
    await serve({ mangas: [manga] });
    const requestId = await recordRequest(201);
    await dataSource
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ status: MediaRequestStatus.APPROVED })
      .where({ id: requestId })
      .callListeners(false)
      .execute();
    const dispatched: number[] = [];
    mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async (id: number) => {
        dispatched.push(id);
        return { delivered: true };
      }
    );
    const agent = await asAdmin();

    const bound = await agent
      .post(`${BASE}/bind`)
      .send({ instanceId: 1, anilistId: 201, suwayomiMangaId: 1 });
    assert.equal(bound.status, 200);
    await waitForBackgroundTasks();

    assert.deepEqual(await requestStates(), [[201, 'BOUND']]);
    assert.deepEqual(dispatched, [requestId]);
    assert.equal(await getRepository(RequestDispatchOutbox).count(), 0);
  });
});

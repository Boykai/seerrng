import AnilistAPI from '@server/api/anilist';
import MangaDexAPI from '@server/api/mangadex';
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
import type {
  MangaResolveBindResponse,
  MangaResolveDetail,
  MangaResolveTitle,
} from '@server/interfaces/api/mangaResolveInterfaces';
import { createMangaMedia, getMangaAdmissionKey } from '@server/lib/mangaMedia';
import { DEFAULT_MANGA_REQUEST_SCOPE } from '@server/lib/mangaRequests';
import requestAdmissionCoordinator from '@server/lib/requestAdmission';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { setupTestDb } from '@server/test/db';
import {
  fakeLibraryManga,
  graphqlErrors,
  serveFakeLibrary,
  startFakeSuwayomi,
  syntheticFailure,
  type FakeLibrary,
  type FakeLibraryManga,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
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

const BASE = '/api/v1/manga/resolve';
type Query = Record<string, string | number>;
type Agent = ReturnType<typeof request.agent>;
const PASSWORD = randomUUID();
const [T1, T2, T3, T4, T5, T6] = [
  920001, 920002, 920003, 920004, 920005, 920006,
];
const OTHER_TITLE = 920009;
const U1 = '0b0b0b0b-0000-4000-8000-000000000001';
const { APPROVED, PENDING } = MediaRequestStatus;
const { AWAITING_BINDING, BOUND } = MangaRequestBindingState;
const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const servers: FakeSuwayomi[] = [];
/** Picker responses that break the API spec. */
const responseErrors: string[] = [];
/** Outside calls made while an admission was held. */
let violations: string[] = [];
let admissions: { resources: string[]; depth: number }[] = [];
let depth = 0;
let lookups: string[] = [];

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

const totalRequests = () =>
  servers.reduce((sum, server) => sum + server.requests.length, 0);

const originalRun = requestAdmissionCoordinator.run.bind(
  requestAdmissionCoordinator
);
const observedRun: typeof requestAdmissionCoordinator.run = (
  resources,
  callback
) => {
  admissions.push({ resources: [...resources], depth });
  return originalRun(resources, async () => {
    const before = totalRequests();
    depth += 1;
    try {
      return await callback();
    } finally {
      depth -= 1;
      if (totalRequests() !== before) violations.push('suwayomi');
    }
  });
};

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

/** Serves `library` from a fake server configured as instance 1. */
const serve = async (
  library: FakeLibrary = { mangas: [] },
  sourceAllowlist = ['1001', '1002']
) => {
  const server = await startFakeSuwayomi({
    mode: 'NONE',
    username: 'fake-user',
    password: PASSWORD,
  });
  serveFakeLibrary(server, library);
  servers.push(server);
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
    sourceAllowlist,
    preferredLanguages: [],
    scanlatorPreference: [],
    requireCbz: true,
  });
  return server;
};

/** A source manga that is not in the Suwayomi library unless served so. */
const sourceManga = (id: number, overrides: Partial<FakeLibraryManga> = {}) =>
  fakeLibraryManga(id, {
    sourceId: '1001',
    url: `/fake-title/${id}`,
    title: `Synthetic Source Title ${id}`,
    ...overrides,
  });

/** A manga request whose manifest waits for a binding on instance 1. */
const seedRequest = async (
  anilistId: number,
  status = APPROVED,
  bindingState = AWAITING_BINDING
) => {
  const media = await createMangaMedia(
    dataSource.manager,
    anilistId,
    MediaStatus.PENDING
  );
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const saved = await getRepository(MediaRequest).save(
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
      requestId: saved.id,
      anilistId,
      instanceId: 1,
      ...DEFAULT_MANGA_REQUEST_SCOPE,
      bindingState,
      boundAt: bindingState === BOUND ? new Date() : null,
    })
  );
  return saved.id;
};

const seedResolution = (
  anilistId: number,
  overrides: Partial<MangaSourceResolution>
) =>
  getRepository(MangaSourceResolution).save(
    new MangaSourceResolution({ instanceId: 1, anilistId, ...overrides })
  );

/** A title match by default; `exact` makes it an exact link. */
const seedCandidate = (
  anilistId: number,
  manga: FakeLibraryManga,
  { exact = false, score = 960 }: { exact?: boolean; score?: number } = {}
) =>
  getRepository(MangaSourceCandidate).save(
    new MangaSourceCandidate({
      instanceId: 1,
      anilistId,
      sourceId: manga.sourceId,
      sourceName: `Synthetic Source ${manga.sourceId}`,
      sourceLang: 'en',
      url: manga.url,
      urlHash: hashMangaSourceUrl(manga.url),
      suwayomiMangaId: manga.id,
      title: manga.title,
      score: exact ? 1000 : score,
      confidence: exact
        ? MangaBindingConfidence.EXACT_LINK
        : MangaBindingConfidence.HIGH,
      matchedBy: exact ? 'mangadex-link' : 'title',
    })
  );

/** The resolver's binding outside the library, by default. */
const seedBinding = (
  anilistId: number,
  manga: FakeLibraryManga,
  overrides: Partial<MangaSourceBinding> = {}
) =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId: 1,
      sourceId: manga.sourceId,
      url: manga.url,
      urlHash: hashMangaSourceUrl(manga.url),
      anilistId,
      suwayomiMangaId: manga.id,
      title: manga.title,
      confidence: MangaBindingConfidence.EXACT_LINK,
      matchedBy: 'mangadex-link',
      origin: 'resolver',
      state: MangaBindingState.ACTIVE,
      inLibrary: false,
      ...overrides,
    })
  );

const bindings = () =>
  getRepository(MangaSourceBinding).find({ order: { id: 'ASC' } });

const resolution = (anilistId: number) =>
  getRepository(MangaSourceResolution).findOneBy({ instanceId: 1, anilistId });

const manifestOf = async (requestId: number) =>
  (await getRepository(MangaRequestManifest).findOneByOrFail({ requestId }))
    .bindingState;

const requestStatusOf = async (requestId: number) =>
  (await getRepository(MediaRequest).findOneByOrFail({ id: requestId })).status;

const decision = (body: unknown) => {
  const { outcome, binding, title } = body as MangaResolveBindResponse;
  return {
    outcome,
    binding: {
      anilistId: binding.anilistId,
      sourceId: binding.sourceId,
      url: binding.url,
      suwayomiMangaId: binding.suwayomiMangaId,
      confidence: binding.confidence,
      matchedBy: binding.matchedBy,
      origin: binding.origin,
      state: binding.state,
      inLibrary: binding.inLibrary,
    },
    title: [title.status, title.reason],
  };
};

const failure = (res: { status: number; body: unknown }) => [
  res.status,
  (res.body as { code?: string }).code,
];

const select = (agent: Agent, anilistId: number, candidateId: number) =>
  agent
    .post(`${BASE}/${anilistId}/select`)
    .send({ instanceId: 1, candidateId });

const bind = (agent: Agent, anilistId: number, body: Record<string, unknown>) =>
  agent.post(`${BASE}/${anilistId}/bind`).send({ instanceId: 1, ...body });

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  configure();
  violations = [];
  admissions = [];
  depth = 0;
  lookups = [];
  mock.method(requestAdmissionCoordinator, 'run', observedRun);
  // No picker route looks anything up outside Suwayomi.
  const lookup = (name: string) => async () => {
    lookups.push(name);
    throw new Error('unexpected lookup');
  };
  mock.method(AnilistAPI.prototype, 'getMangaDetails', lookup('anilist'));
  mock.method(AnilistAPI.prototype, 'getMangaIdsByMalIds', lookup('mal'));
  mock.method(AnilistAPI.prototype, 'searchMangaTitles', lookup('titles'));
  mock.method(MangaDexAPI.prototype, 'getAniListLinks', lookup('links'));
  mock.method(MangaDexAPI.prototype, 'searchMangaByTitle', lookup('search'));
});

afterEach(async () => {
  mock.restoreAll();
  settings.main.enabledMediaCategories = categories;
  configure();
  try {
    assert.deepEqual(violations, []);
    assert.deepEqual(lookups, []);
    // The picker only reads from Suwayomi; searches belong to the job.
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

describe('manga resolve picker: access', () => {
  it('is admin-only and hidden while the manga category is off', async () => {
    const manga = sourceManga(101);
    const server = await serve({ mangas: [], outside: [manga] });
    await seedRequest(T1);
    const candidate = await seedCandidate(T1, manga);
    const routes = (agent: Agent) => [
      () => agent.get(BASE),
      () => agent.get(`${BASE}/${T1}`).query({ instanceId: 1 }),
      () => agent.post(`${BASE}/${T1}/search`).send({ instanceId: 1 }),
      () => select(agent, T1, candidate.id),
      () => bind(agent, T1, { suwayomiMangaId: manga.id }),
    ];
    // One request at a time: supertest closes an agent's server when the
    // request that opened it ends, which can reset requests still in flight.
    const statuses = async (agent: Agent) => {
      const sent: number[] = [];
      for (const send of routes(agent)) sent.push((await send()).status);
      return sent;
    };

    const friend = await loginAs('friend@seerr.dev');
    assert.deepEqual(await statuses(friend), [403, 403, 403, 403, 403]);
    assert.equal((await request(app).get(BASE)).status, 403);

    const admin = await asAdmin();
    settings.main.enabledMediaCategories = { ...categories, manga: false };
    assert.deepEqual(await statuses(admin), [404, 404, 404, 404, 404]);

    assert.deepEqual(await bindings(), []);
    assert.equal(await resolution(T1), null);
    assert.deepEqual(server.requests, []);
  });
});

describe('manga resolve picker: titles', () => {
  it('lists the waiting titles with their status, oldest request first', async () => {
    await seedRequest(T1);
    await seedRequest(T2, PENDING);
    await seedRequest(T3);
    await seedResolution(T3, {
      status: MangaResolutionStatus.NEEDS_PICK,
      reason: 'TITLE_MATCHES',
      attempts: 0,
      nextAttemptAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    await seedCandidate(T3, sourceManga(101));
    await seedCandidate(T3, sourceManga(102));
    await seedRequest(T4);
    await seedResolution(T4, {
      status: MangaResolutionStatus.NO_MATCH,
      reason: 'NO_CANDIDATES',
      attempts: 2,
      lastError: 'SOURCE_SEARCH_FAILED',
    });
    await seedRequest(T5);
    await seedResolution(T5, {
      status: MangaResolutionStatus.EXCLUDED,
      reason: 'CONTENT_POLICY',
    });
    await seedRequest(T6, APPROVED, BOUND);
    const agent = await asAdmin();
    const list = (query: Query) => agent.get(BASE).query(query);
    const ids = async (query: Query) => {
      const res = await list(query);
      assert.equal(res.status, 200);
      return res.body.results.map(
        ({ anilistId }: MangaResolveTitle) => anilistId
      );
    };

    const all = await list({});
    assert.equal(all.status, 200);
    assert.deepEqual(
      (all.body.results as MangaResolveTitle[]).map(
        ({ anilistId, status, reason, approved, candidateCount, attempts }) => [
          anilistId,
          status,
          reason,
          approved,
          candidateCount,
          attempts,
        ]
      ),
      [
        [T1, 'QUEUED', null, true, 0, 0],
        [T2, 'AWAITING_APPROVAL', null, false, 0, 0],
        [T3, 'NEEDS_PICK', 'TITLE_MATCHES', true, 2, 0],
        [T4, 'NO_MATCH', 'NO_CANDIDATES', true, 0, 2],
        [T5, 'EXCLUDED', 'CONTENT_POLICY', true, 0, 0],
      ]
    );
    const third = (all.body.results as MangaResolveTitle[])[2];
    assert.equal(third.nextAttemptAt, '2030-01-01T00:00:00.000Z');
    assert.equal(third.instanceId, 1);
    assert.equal(
      (all.body.results as MangaResolveTitle[])[3].lastError,
      'SOURCE_SEARCH_FAILED'
    );
    assert.deepEqual(all.body.pageInfo, {
      page: 1,
      pages: 1,
      pageSize: 20,
      results: 5,
    });

    assert.deepEqual((await list({ take: 2 })).body.pageInfo, {
      page: 1,
      pages: 3,
      pageSize: 2,
      results: 5,
    });
    assert.deepEqual(await ids({ take: 2, skip: 2 }), [T3, T4]);
    assert.deepEqual(await ids({ status: 'QUEUED' }), [T1]);
    assert.deepEqual(await ids({ status: 'AWAITING_APPROVAL' }), [T2]);
    assert.deepEqual(await ids({ status: 'NEEDS_PICK' }), [T3]);
    assert.deepEqual(await ids({ status: 'NO_MATCH' }), [T4]);
    assert.deepEqual(await ids({ status: 'EXCLUDED' }), [T5]);
    const invalid: Query[] = [
      { take: 0 },
      { take: 101 },
      { skip: -1 },
      { status: 'BOUND' },
      { unknown: 1 },
    ];
    for (const query of invalid) {
      assert.equal((await list(query)).status, 400);
    }
  });

  it("shows a title's candidates, exact links first, and its live bindings", async () => {
    await seedRequest(T1);
    await seedResolution(T1, {
      status: MangaResolutionStatus.NEEDS_PICK,
      reason: 'EXACT_BOUND_ELSEWHERE',
      mangadexUuid: U1,
    });
    const match = await seedCandidate(T1, sourceManga(101), { score: 1000 });
    const exact = await seedCandidate(
      T1,
      sourceManga(201, { sourceId: '1002', url: `/manga/${U1}` }),
      { exact: true }
    );
    const weaker = await seedCandidate(T1, sourceManga(102), { score: 800 });
    const orphan = await seedBinding(T1, sourceManga(103), {
      state: MangaBindingState.ORPHANED,
    });
    await seedBinding(T1, sourceManga(104), {
      state: MangaBindingState.REJECTED,
    });
    await seedBinding(T1, sourceManga(105), { instanceId: 2 });
    await seedRequest(T2, APPROVED, BOUND);
    const active = await seedBinding(T2, sourceManga(106));
    const agent = await asAdmin();
    const detail = (anilistId: number | string, query: Query) =>
      agent.get(`${BASE}/${anilistId}`).query(query);

    const res = await detail(T1, { instanceId: 1 });

    assert.equal(res.status, 200);
    const body = res.body as MangaResolveDetail;
    assert.deepEqual(
      [body.status, body.reason, body.mangadexUuid, body.candidateCount],
      ['NEEDS_PICK', 'EXACT_BOUND_ELSEWHERE', U1, 3]
    );
    assert.deepEqual(
      body.candidates.map(({ id, score, confidence, matchedBy }) => [
        id,
        score,
        confidence,
        matchedBy,
      ]),
      [
        [exact.id, 1, 'EXACT_LINK', 'mangadex-link'],
        [match.id, 1, 'HIGH', 'title'],
        [weaker.id, 0.8, 'HIGH', 'title'],
      ]
    );
    const [first] = body.candidates;
    assert.deepEqual(
      [first.sourceId, first.sourceName, first.sourceLang, first.url],
      ['1002', 'Synthetic Source 1002', 'en', `/manga/${U1}`]
    );
    assert.equal(body.candidates[0].title, 'Synthetic Source Title 201');
    assert.equal(body.candidates[0].inLibrary, false);
    assert.deepEqual(
      body.bindings.map(({ id, state }) => [id, state]),
      [[orphan.id, 'ORPHANED']]
    );

    const bound = (await detail(T2, { instanceId: 1 }))
      .body as MangaResolveDetail;
    assert.deepEqual(
      [bound.status, bound.reason, bound.candidates],
      ['BOUND', 'EXISTING_BINDING', []]
    );
    assert.deepEqual(
      bound.bindings.map(({ id, state }) => [id, state]),
      [[active.id, 'ACTIVE']]
    );

    assert.deepEqual(failure(await detail(T3, { instanceId: 1 })), [
      404,
      'MANGA_RESOLVE_TITLE_NOT_FOUND',
    ]);
    assert.deepEqual(failure(await detail(T1, { instanceId: 2 })), [
      404,
      'MANGA_RESOLVE_TITLE_NOT_FOUND',
    ]);
    for (const [anilistId, query] of [
      [T1, {}],
      [T1, { instanceId: 'x' }],
      [0, { instanceId: 1 }],
    ] as const) {
      assert.equal((await detail(anilistId, query)).status, 400);
    }
  });

  it('shows a waiting title that no run will search as awaiting approval', async () => {
    const failed: Partial<MangaSourceResolution> = {
      status: MangaResolutionStatus.QUEUED,
      lastError: 'SOURCE_SEARCH_FAILED',
      nextAttemptAt: new Date('2030-01-01T00:00:00.000Z'),
    };
    await seedRequest(T1, PENDING);
    await seedResolution(T1, failed);
    await seedRequest(T2, PENDING);
    await seedResolution(T2, {
      ...failed,
      searchRequestedAt: new Date('2029-12-31T00:00:00.000Z'),
    });
    await seedRequest(T3, PENDING);
    await seedResolution(T3, {
      status: MangaResolutionStatus.BOUND,
      reason: 'EXACT_LINK',
    });
    await seedRequest(T4);
    await seedResolution(T4, failed);

    const res = await (await asAdmin()).get(BASE);

    assert.equal(res.status, 200);
    assert.deepEqual(
      (res.body.results as MangaResolveTitle[]).map(
        ({ anilistId, status, reason, lastError }) => [
          anilistId,
          status,
          reason,
          lastError,
        ]
      ),
      [
        [T1, 'AWAITING_APPROVAL', null, 'SOURCE_SEARCH_FAILED'],
        [T2, 'QUEUED', null, 'SOURCE_SEARCH_FAILED'],
        [T3, 'AWAITING_APPROVAL', null, null],
        [T4, 'QUEUED', null, 'SOURCE_SEARCH_FAILED'],
      ]
    );
  });
});

describe('manga resolve picker: search', () => {
  it('queues a search for a pending title with a fresh backoff', async () => {
    const requestId = await seedRequest(T1, PENDING);
    await seedResolution(T1, {
      status: MangaResolutionStatus.NO_MATCH,
      reason: 'NO_CANDIDATES',
      attempts: 3,
      nextAttemptAt: new Date('2030-01-01T00:00:00.000Z'),
      lastError: 'SOURCE_SEARCH_FAILED',
    });
    const server = await serve();
    const agent = await asAdmin();

    const res = await agent
      .post(`${BASE}/${T1}/search`)
      .send({ instanceId: 1 });

    assert.equal(res.status, 202);
    assert.equal(res.body.runStarted, false);
    const title = res.body.title as MangaResolveTitle;
    assert.deepEqual(
      [
        title.status,
        title.reason,
        title.attempts,
        title.nextAttemptAt,
        title.lastError,
        title.approved,
      ],
      ['QUEUED', null, 0, null, null, false]
    );
    assert.ok(title.searchRequestedAt);
    const row = await resolution(T1);
    assert.equal(row?.status, MangaResolutionStatus.QUEUED);
    assert.ok(row?.searchRequestedAt);
    assert.equal(await requestStatusOf(requestId), PENDING);
    assert.deepEqual(
      (await agent.get(BASE).query({ status: 'QUEUED' })).body.results.map(
        ({ anilistId }: MangaResolveTitle) => anilistId
      ),
      [T1]
    );
    assert.deepEqual(server.requests, []);
  });

  it('refuses an unknown title or instance and a bound title', async () => {
    await seedRequest(T1);
    const agent = await asAdmin();
    const search = (anilistId: number, body: Record<string, unknown>) =>
      agent.post(`${BASE}/${anilistId}/search`).send(body);

    assert.deepEqual(failure(await search(T1, { instanceId: 1 })), [
      404,
      'MANGA_INSTANCE_NOT_FOUND',
    ]);
    await serve();
    assert.deepEqual(failure(await search(T3, { instanceId: 1 })), [
      404,
      'MANGA_RESOLVE_TITLE_NOT_FOUND',
    ]);
    await seedBinding(T1, sourceManga(101));
    assert.deepEqual(failure(await search(T1, { instanceId: 1 })), [
      409,
      'MANGA_ALREADY_BOUND',
    ]);
    for (const body of [{}, { instanceId: 'x' }, { instanceId: 1, x: 1 }]) {
      assert.equal((await search(T1, body)).status, 400);
    }
    assert.equal(await resolution(T1), null);
  });
});

describe('manga resolve picker: select', () => {
  it('binds an exact candidate with its MangaDex credit and un-parks the request', async () => {
    const manga = sourceManga(101, { url: `/manga/${U1}` });
    await serve({ mangas: [], outside: [manga] });
    const requestId = await seedRequest(T1);
    await seedResolution(T1, {
      status: MangaResolutionStatus.NEEDS_PICK,
      reason: 'EXACT_NOT_PREFERRED',
      mangadexUuid: U1,
    });
    const candidate = await seedCandidate(T1, manga, { exact: true });
    const agent = await asAdmin();
    admissions = [];

    const res = await select(agent, T1, candidate.id);

    assert.equal(res.status, 200);
    assert.deepEqual(decision(res.body), {
      outcome: 'bound',
      binding: {
        anilistId: T1,
        sourceId: '1001',
        url: `/manga/${U1}`,
        suwayomiMangaId: 101,
        confidence: 'EXACT_LINK',
        matchedBy: 'mangadex-link',
        origin: 'admin',
        state: 'ACTIVE',
        inLibrary: false,
      },
      title: ['BOUND', 'ADMIN_BIND'],
    });
    assert.equal(res.body.binding.title, manga.title);
    assert.equal(await manifestOf(requestId), BOUND);
    assert.equal(await requestStatusOf(requestId), APPROVED);
    // The admin's mutation admission comes first, as in the library review;
    // then the title's, the instance's, and the title's again for its status.
    const key = getMangaAdmissionKey(T1);
    assert.deepEqual(admissions, [
      { resources: ['user-security:user:1'], depth: 0 },
      { resources: [key], depth: 1 },
      { resources: ['service-config:suwayomi:1'], depth: 2 },
      { resources: [key], depth: 1 },
    ]);

    const again = await select(agent, T1, candidate.id);
    assert.equal(again.status, 200);
    assert.equal(again.body.outcome, 'unchanged');
    assert.equal((await bindings()).length, 1);
  });

  it('binds a title match as a manual decision', async () => {
    const manga = sourceManga(201, { sourceId: '1002' });
    await serve({ mangas: [], outside: [manga] });
    const requestId = await seedRequest(T1);
    const candidate = await seedCandidate(T1, manga);
    const agent = await asAdmin();

    const res = await select(agent, T1, candidate.id);

    assert.equal(res.status, 200);
    assert.deepEqual(decision(res.body).binding, {
      anilistId: T1,
      sourceId: '1002',
      url: manga.url,
      suwayomiMangaId: 201,
      confidence: 'MANUAL',
      matchedBy: 'manual',
      origin: 'admin',
      state: 'ACTIVE',
      inLibrary: false,
    });
    assert.equal(await manifestOf(requestId), BOUND);
  });

  it('refuses a candidate that is gone, unknown or no longer allowed', async () => {
    const known = sourceManga(101);
    await serve({ mangas: [], outside: [known] }, ['1001']);
    await seedRequest(T1);
    await seedRequest(T2);
    const gone = await seedCandidate(T1, sourceManga(102));
    const unlisted = await seedCandidate(
      T1,
      sourceManga(301, { sourceId: '1003' })
    );
    const others = await seedCandidate(T2, known);
    const agent = await asAdmin();

    assert.deepEqual(failure(await select(agent, T1, gone.id)), [
      409,
      'MANGA_CANDIDATE_GONE',
    ]);
    assert.deepEqual(failure(await select(agent, T1, unlisted.id)), [
      400,
      'MANGA_SOURCE_NOT_ALLOWED',
    ]);
    assert.deepEqual(failure(await select(agent, T1, others.id)), [
      404,
      'MANGA_CANDIDATE_NOT_FOUND',
    ]);
    assert.deepEqual(failure(await select(agent, T1, 999_999)), [
      404,
      'MANGA_CANDIDATE_NOT_FOUND',
    ]);
    assert.deepEqual(failure(await select(agent, T3, others.id)), [
      404,
      'MANGA_RESOLVE_TITLE_NOT_FOUND',
    ]);
    assert.equal((await select(agent, T1, 0)).status, 400);
    assert.deepEqual(await bindings(), []);
  });
});

describe('manga resolve picker: bind', () => {
  it('binds a manga Suwayomi knows by its source key or its ID', async () => {
    const first = sourceManga(101);
    const second = sourceManga(201, { sourceId: '1002' });
    await serve({ mangas: [], outside: [first, second] });
    const one = await seedRequest(T1);
    const two = await seedRequest(T2);
    const agent = await asAdmin();

    const byKey = await bind(agent, T1, {
      sourceId: first.sourceId,
      url: first.url,
    });
    const byId = await bind(agent, T2, { suwayomiMangaId: second.id });

    assert.equal(byKey.status, 200);
    assert.equal(byId.status, 200);
    assert.deepEqual(
      [decision(byKey.body), decision(byId.body)].map(({ binding }) => [
        binding.anilistId,
        binding.sourceId,
        binding.suwayomiMangaId,
        binding.confidence,
        binding.matchedBy,
        binding.origin,
        binding.inLibrary,
      ]),
      [
        [T1, '1001', 101, 'MANUAL', 'manual', 'admin', false],
        [T2, '1002', 201, 'MANUAL', 'manual', 'admin', false],
      ]
    );
    assert.deepEqual(
      [await manifestOf(one), await manifestOf(two)],
      [BOUND, BOUND]
    );
    assert.equal((await resolution(T2))?.reason, 'ADMIN_BIND');
  });

  it('refuses local, unlisted, unknown and malformed manga', async () => {
    const unlisted = sourceManga(301, { sourceId: '1003' });
    const server = await serve({ mangas: [], outside: [unlisted] });
    await seedRequest(T1);
    const agent = await asAdmin();
    const refused = async (body: Record<string, unknown>) =>
      failure(await bind(agent, T1, body));

    assert.deepEqual(await refused({ sourceId: '0', url: '/fake-title/1' }), [
      400,
      'MANGA_SOURCE_NOT_ALLOWED',
    ]);
    assert.deepEqual(await refused({ sourceId: '1003', url: unlisted.url }), [
      400,
      'MANGA_SOURCE_NOT_ALLOWED',
    ]);
    assert.equal(server.requests.length, 0);
    assert.deepEqual(await refused({ suwayomiMangaId: unlisted.id }), [
      400,
      'MANGA_SOURCE_NOT_ALLOWED',
    ]);
    assert.deepEqual(await refused({ suwayomiMangaId: 999 }), [
      404,
      'MANGA_ITEM_NOT_FOUND',
    ]);
    assert.deepEqual(
      await refused({ sourceId: '1001', url: '/fake-title/404' }),
      [404, 'MANGA_ITEM_NOT_FOUND']
    );
    assert.deepEqual(
      await refused({ sourceId: '9999999999999999999', url: '/fake-title/1' }),
      [400, 'MANGA_INVALID_REQUEST']
    );
    assert.deepEqual(
      await refused({ sourceId: '1001', url: '/fake-title/\u0007' }),
      [400, 'MANGA_INVALID_REQUEST']
    );
    for (const body of [
      { sourceId: '99999999999999999999', url: '/fake-title/1' },
      { sourceId: '1001' },
      { suwayomiMangaId: 1, sourceId: '1001', url: '/fake-title/1' },
      { suwayomiMangaId: 0 },
    ]) {
      assert.equal((await bind(agent, T1, body)).status, 400);
    }
    assert.deepEqual(await bindings(), []);
  });

  it('refuses a manga bound to another title and revives a rejected pair', async () => {
    const taken = sourceManga(101);
    const rejected = sourceManga(102);
    await serve({ mangas: [], outside: [taken, rejected] });
    const requestId = await seedRequest(T1);
    const other = await seedBinding(OTHER_TITLE, taken);
    const pair = await seedBinding(T1, rejected, {
      confidence: MangaBindingConfidence.HIGH,
      matchedBy: 'title',
      origin: 'library-scan',
      state: MangaBindingState.REJECTED,
    });
    const agent = await asAdmin();

    assert.deepEqual(
      failure(await bind(agent, T1, { suwayomiMangaId: taken.id })),
      [409, 'MANGA_ITEM_BOUND_ELSEWHERE']
    );
    assert.equal(await manifestOf(requestId), AWAITING_BINDING);

    const res = await bind(agent, T1, { suwayomiMangaId: rejected.id });

    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'bound');
    assert.deepEqual(
      (await bindings()).map(({ id, anilistId, state, confidence, origin }) => [
        id,
        anilistId,
        state,
        confidence,
        origin,
      ]),
      [
        [other.id, OTHER_TITLE, 'ACTIVE', 'EXACT_LINK', 'resolver'],
        [pair.id, T1, 'ACTIVE', 'MANUAL', 'admin'],
      ]
    );
    assert.equal(await manifestOf(requestId), BOUND);
  });

  it('links a manga in the library as the library review does', async () => {
    const linked = sourceManga(101, {
      url: `/manga/${U1}`,
      chapterCount: 2,
      downloadCount: 2,
    });
    const taken = sourceManga(102, { chapterCount: 1, downloadCount: 1 });
    await serve({ mangas: [linked, taken] });
    const requestId = await seedRequest(T1);
    const candidate = await seedCandidate(T1, linked, { exact: true });
    await seedBinding(OTHER_TITLE, taken, {
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      inLibrary: true,
    });
    const agent = await asAdmin();

    assert.deepEqual(
      failure(await bind(agent, T1, { suwayomiMangaId: taken.id })),
      [409, 'MANGA_ITEM_BOUND_ELSEWHERE']
    );

    const res = await select(agent, T1, candidate.id);

    assert.equal(res.status, 200);
    assert.deepEqual(decision(res.body), {
      outcome: 'bound',
      binding: {
        anilistId: T1,
        sourceId: '1001',
        url: linked.url,
        suwayomiMangaId: 101,
        confidence: 'MANUAL',
        matchedBy: 'manual',
        origin: 'admin',
        state: 'ACTIVE',
        inLibrary: true,
      },
      title: ['BOUND', 'ADMIN_BIND'],
    });
    assert.equal(res.body.binding.availability, MediaStatus.AVAILABLE);
    assert.equal(await manifestOf(requestId), BOUND);

    const again = await bind(agent, T1, { suwayomiMangaId: linked.id });
    assert.equal(again.status, 200);
    assert.equal(again.body.outcome, 'unchanged');
    assert.equal((await bindings()).length, 2);
  });

  it('reports a failed Suwayomi lookup and writes nothing', async () => {
    const server = await serve();
    server.onOperation('ByNaturalKey', graphqlErrors([syntheticFailure()]));
    await seedRequest(T1);
    const agent = await asAdmin();

    const res = await bind(agent, T1, {
      sourceId: '1001',
      url: '/fake-title/101',
    });

    assert.deepEqual(
      [res.status, res.body],
      [
        502,
        {
          code: 'MANGA_SUWAYOMI_LOOKUP_FAILED',
          message: 'The Suwayomi lookup failed.',
          suwayomiCode: 'UPSTREAM_ERROR',
        },
      ]
    );
    assert.deepEqual(await bindings(), []);
    assert.equal(await resolution(T1), null);
  });
});

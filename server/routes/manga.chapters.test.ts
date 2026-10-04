import AnilistAPI from '@server/api/anilist';
import {
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist/failures';
import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { getSettings, type SuwayomiSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import * as userSecurityMutation from '@server/lib/userSecurityMutation';
import { setupTestDb } from '@server/test/db';
import {
  FAKE_URL_PREFIX,
  dispatchInstanceFor,
  fakeChapterUrl,
  fakeDispatchChapters,
  fakeDispatchManga,
  seedDispatchBinding,
  type FakeDispatchManga,
} from '@server/test/fakeSuwayomiDispatch';
import {
  seedProgressRequest,
  startFakeProgressSuwayomi,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
import {
  DOWNLOAD_TITLE,
  archiveReply,
  assertPrivateLogs,
  captureLogs,
  downloadedManga,
  logsOf,
  seedDeliveredRequest,
  serveArchive,
  slotsReleased,
  type CapturedLog,
} from '@server/test/mangaDownloadCopies';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
  type Mock,
} from 'node:test';
import request from 'supertest';
import router from './index';
import mangaRoutes from './manga';

setupTestDb();

const settings = getSettings();
const fakes: FakeProgressSuwayomi[] = [];
const chapterCache = () => cacheManager.getCache('suwayomichapters');
let app: Express;
let logs: CapturedLog[] = [];
let anilist: (anilistId: number) => Promise<AnilistMangaDetails | null>;
let getDetails: Mock<AnilistAPI['getMangaDetails']>;
let originalMain: Pick<
  typeof settings.main,
  | 'enabledMediaCategories'
  | 'cacheImages'
  | 'mangaIncludeAdult'
  | 'mangaIncludeNovels'
>;

const NOT_FOUND = { status: 404, message: 'Manga not found.' };
const UNAVAILABLE = {
  status: 503,
  message: 'Chapters are unavailable right now.',
};
const READ_OPERATIONS = new Set([
  'ByNaturalKey',
  'ChaptersToDownload',
  'DownloadedChapters',
]);
const LOG_FIELDS = new Set([
  'label',
  'anilistId',
  'code',
  'operation',
  'httpStatus',
]);

const chaptersPath = (query = '') => `/api/v1/manga/9001/chapters${query}`;

type ErrorBody = { status?: number; message?: string };

const errorHandler = (
  err: ErrorBody,
  _req: express.Request,
  res: express.Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: express.NextFunction
) => {
  res
    .status(err.status ?? 500)
    .json({ status: err.status ?? 500, message: err.message });
};

const createApp = (): Express => {
  const created = express();
  created.use(express.json());
  created.use(
    // Test-only session middleware has no network listener or real secret.
    // codeql[js/clear-text-cookie]
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  created.use('/api/v1', router);
  created.use(errorHandler);
  return created;
};

// Validates requests and responses against the published contract. Error
// responses document a description only, so their bodies are checked with
// response validation off.
const createContractApp = ({ validateResponses = true } = {}): Express => {
  const created = express();
  created.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateResponses,
      validateSecurity: false,
    })
  );
  created.use((req, _res, next) => {
    req.user = new User({ id: 2, permissions: Permission.REQUEST });
    next();
  });
  created.use('/api/v1/manga', mangaRoutes);
  created.use(errorHandler);
  return created;
};

const details = (
  overrides: Partial<AnilistMangaDetails> = {}
): AnilistMangaDetails => ({
  id: 9001,
  titles: { english: DOWNLOAD_TITLE },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  tags: [],
  staff: [],
  ...overrides,
});

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

/** A fake serving `mangas` as instance 1, the only configured instance. */
const start = async (...mangas: FakeDispatchManga[]) => {
  const fake = await startFakeProgressSuwayomi(mangas);
  fakes.push(fake);
  configure(dispatchInstanceFor(fake.server));
  return fake;
};

/** A library manga of three chapters, bound to AniList title 9001. */
const startLibrary = async () => {
  const manga = fakeDispatchManga(21, { inLibrary: true });
  const fake = await start(manga);
  await seedDispatchBinding(manga);
  return fake;
};

const loginAs = async (email: string) => {
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;
  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/v1/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
};

/** Gives the demo user `permissions` and signs it in. */
const demoWith = async (permissions: number) => {
  await getRepository(User).update(3, { permissions });
  return loginAs('demo@seerr.dev');
};

/** Every request so far is a read the chapter list may send. */
const assertReadsOnly = (fake: FakeProgressSuwayomi) => {
  for (const { operationName, query } of fake.server.requests) {
    assert.ok(
      READ_OPERATIONS.has(operationName ?? ''),
      `Unexpected Suwayomi operation ${String(operationName)}`
    );
    assert.match(query ?? '', /^\s*query /);
  }
  assert.deepStrictEqual(fake.writes(), []);
};

type ChapterBody = {
  number: number | null;
  status: string;
  download?: { requestId: number; assetId: string };
};

const statesOf = (body: { results: ChapterBody[] }) =>
  body.results.map(({ number, status, download }) => [
    number,
    status,
    download,
  ]);

before(() => {
  app = createApp();
});

beforeEach(() => {
  const { main } = settings;
  originalMain = {
    enabledMediaCategories: main.enabledMediaCategories,
    cacheImages: main.cacheImages,
    mangaIncludeAdult: main.mangaIncludeAdult,
    mangaIncludeNovels: main.mangaIncludeNovels,
  };
  main.enabledMediaCategories = { ...main.enabledMediaCategories, manga: true };
  // Keep image warming from reaching the AniList CDN.
  main.cacheImages = false;
  main.mangaIncludeAdult = false;
  main.mangaIncludeNovels = false;
  chapterCache().flush();
  configure();
  logs = captureLogs();
  anilist = async (anilistId) => details({ id: anilistId });
  getDetails = mock.method(
    AnilistAPI.prototype,
    'getMangaDetails',
    (anilistId: number) => anilist(anilistId)
  );
  mock.method(notificationManager, 'sendNotificationIntent', async () => {
    return;
  });
});

afterEach(async () => {
  try {
    await waitForBackgroundTasks();
    await slotsReleased();
    assertPrivateLogs(logs);
  } finally {
    mock.restoreAll();
    Object.assign(settings.main, originalMain);
    configure();
    chapterCache().flush();
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

describe('GET /manga/:id/chapters', () => {
  it('answers like unknown routes while manga is disabled, before AniList and Suwayomi', async () => {
    const fake = await startLibrary();
    const agent = await loginAs('friend@seerr.dev');
    settings.main.enabledMediaCategories = {
      ...settings.main.enabledMediaCategories,
      manga: false,
    };

    const res = await agent.get(chaptersPath());

    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.body, { status: 404, message: 'Not found.' });
    assert.strictEqual(getDetails.mock.callCount(), 0);
    assert.deepStrictEqual(fake.server.requests, []);
  });

  it('requires a signed-in user', async () => {
    const fake = await startLibrary();

    const res = await request(app).get(chaptersPath());

    assert.strictEqual(res.status, 403);
    assert.strictEqual(getDetails.mock.callCount(), 0);
    assert.deepStrictEqual(fake.server.requests, []);
  });

  it('answers unknown and excluded titles exactly like the details route, before Suwayomi', async () => {
    const fake = await startLibrary();
    const agent = await loginAs('friend@seerr.dev');

    for (const current of [
      details({ isAdult: true }),
      details({ format: 'NOVEL' }),
      null,
    ]) {
      anilist = async () => current;
      const shown = await agent.get('/api/v1/manga/9001');
      const listed = await agent.get(chaptersPath());

      assert.strictEqual(shown.status, 404);
      assert.strictEqual(listed.status, 404);
      assert.deepStrictEqual(listed.body, NOT_FOUND);
      assert.deepStrictEqual(listed.body, shown.body);
    }
    assert.deepStrictEqual(fake.server.requests, []);

    settings.main.mangaIncludeAdult = true;
    anilist = async () => details({ isAdult: true });
    const res = await agent.get(chaptersPath());

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.inLibrary, true);
    assert.deepStrictEqual(statesOf(res.body), [
      [3, 'notRequested', undefined],
      [2, 'notRequested', undefined],
      [1, 'notRequested', undefined],
    ]);
    assertReadsOnly(fake);
  });

  it('rejects malformed ids and paging before AniList', async () => {
    const agent = await loginAs('friend@seerr.dev');

    for (const id of ['abc', '0', '-1', '1.5', '1000000001']) {
      const res = await agent.get(`/api/v1/manga/${id}/chapters`);
      assert.strictEqual(res.status, 400, id);
      assert.deepStrictEqual(
        res.body,
        { status: 400, message: 'Manga id must be a positive integer.' },
        id
      );
    }
    for (const query of [
      '?page=0',
      '?page=10001',
      '?page=1.5',
      '?page=1&page=2',
    ]) {
      const res = await agent.get(chaptersPath(query));
      assert.strictEqual(res.status, 400, query);
      assert.deepStrictEqual(
        res.body,
        { status: 400, message: 'page must be an integer from 1 to 10000.' },
        query
      );
    }
    for (const query of ['?pageSize=0', '?pageSize=101', '?pageSize=all']) {
      const res = await agent.get(chaptersPath(query));
      assert.strictEqual(res.status, 400, query);
      assert.deepStrictEqual(
        res.body,
        { status: 400, message: 'pageSize must be an integer from 1 to 100.' },
        query
      );
    }
    assert.strictEqual(getDetails.mock.callCount(), 0);
  });

  it('pages the chapters with the requested size', async () => {
    await startLibrary();
    const agent = await loginAs('friend@seerr.dev');

    let res = await agent.get(chaptersPath('?page=2&pageSize=2'));

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.pageInfo, {
      page: 2,
      pages: 2,
      pageSize: 2,
      results: 3,
    });
    assert.deepStrictEqual(statesOf(res.body), [
      [1, 'notRequested', undefined],
    ]);

    res = await agent.get(chaptersPath('?page=3&pageSize=2'));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results, []);

    res = await agent.get(chaptersPath());
    assert.deepStrictEqual(res.body.pageInfo, {
      page: 1,
      pages: 1,
      pageSize: 50,
      results: 3,
    });
  });

  it('reports AniList rate limits and outages like the details route, before Suwayomi', async () => {
    const fake = await startLibrary();
    const agent = await loginAs('friend@seerr.dev');
    anilist = async () => {
      throw new AnilistRateLimitedError(120);
    };

    let res = await agent.get(chaptersPath());

    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.headers['retry-after'], '120');
    assert.deepStrictEqual(res.body, {
      status: 429,
      message: 'AniList rate limit reached. Try again later.',
    });

    anilist = async () => {
      throw new AnilistOutageError();
    };
    res = await agent.get(chaptersPath());

    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.body, {
      status: 503,
      message: 'Unable to retrieve manga details.',
    });
    assert.deepStrictEqual(fake.server.requests, []);
  });

  it('answers 503 with a fixed message when Suwayomi fails or is unreachable, logging codes only', async () => {
    const fake = await startLibrary();
    const agent = await loginAs('friend@seerr.dev');
    fake.fault('ChaptersToDownload', 'error');

    let res = await agent.get(chaptersPath());

    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.body, UNAVAILABLE);

    fakes.splice(fakes.indexOf(fake), 1);
    await fake.close();
    res = await agent.get(chaptersPath());

    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.body, UNAVAILABLE);
    const failures = logsOf(logs, 'Failed to list manga chapters');
    assert.deepStrictEqual(
      failures.map(([level, meta]) => [level, meta.code, meta.anilistId]),
      [
        ['error', 'UPSTREAM_ERROR', 9001],
        ['error', 'UNREACHABLE', 9001],
      ]
    );
    for (const [, meta] of failures) {
      assert.deepStrictEqual(
        Object.keys(meta).filter((key) => !LOG_FIELDS.has(key)),
        []
      );
    }
  });

  it('shows each user the requests and copies they may see, linking the copies the download route lists', async () => {
    const manga = downloadedManga(21, [1, 2]);
    manga.chapters.push(...fakeDispatchChapters(21, [3]));
    const fake = await start(manga);
    const delivered = await seedDeliveredRequest(manga, { numbers: [1, 2] });
    await seedProgressRequest(manga, { numbers: [3], media: delivered.media });
    serveArchive(fake, 2102, archiveReply('chapter two bytes'));
    const friend = await loginAs('friend@seerr.dev');

    const page = await friend.get(chaptersPath());

    assert.strictEqual(page.status, 200, JSON.stringify(page.body));
    assert.deepStrictEqual(
      [...new Set(fake.operationNames())].sort(),
      [...READ_OPERATIONS].sort()
    );
    assertReadsOnly(fake);
    const body = JSON.stringify(page.body);
    assert.ok(!body.includes(FAKE_URL_PREFIX));
    assert.ok(!body.includes(fakeChapterUrl(21, 1)));

    const listing = await friend.get(
      `/api/v1/request/status/${delivered.request.id}/downloads`
    );
    assert.strictEqual(listing.status, 200, JSON.stringify(listing.body));
    const listed = listing.body.results as { id: string; name: string }[];
    assert.deepStrictEqual(
      listed.map(({ name }) => name),
      ['Sample Manga - Ch. 2.cbz', 'Sample Manga - Ch. 1.cbz']
    );
    const owned = [
      [3, 'requested', undefined],
      [
        2,
        'available',
        { requestId: delivered.request.id, assetId: listed[0].id },
      ],
      [
        1,
        'available',
        { requestId: delivered.request.id, assetId: listed[1].id },
      ],
    ];
    assert.deepStrictEqual(statesOf(page.body), owned);

    const copy = await friend.get(
      `/api/v1/request/status/${delivered.request.id}/downloads/${listed[0].id}`
    );
    assert.strictEqual(copy.status, 200);
    assert.match(
      String(copy.headers['content-disposition']),
      /^attachment; filename="Sample Manga - Ch\. 2\.cbz"/
    );

    for (const permissions of [
      Permission.REQUEST | Permission.REQUEST_VIEW,
      Permission.MANAGE_REQUESTS,
    ]) {
      const viewer = await demoWith(permissions);
      const res = await viewer.get(chaptersPath());
      assert.deepStrictEqual(statesOf(res.body), owned, String(permissions));
    }
    const admin = await loginAs('admin@seerr.dev');
    assert.deepStrictEqual(
      statesOf((await admin.get(chaptersPath())).body),
      owned
    );

    const stranger = await demoWith(Permission.REQUEST);
    assert.deepStrictEqual(
      statesOf((await stranger.get(chaptersPath())).body),
      [
        [3, 'notRequested', undefined],
        [2, 'available', undefined],
        [1, 'available', undefined],
      ]
    );
  });

  it('answers 403 when the signed-in account no longer matches its session', async () => {
    await startLibrary();
    const agent = await loginAs('friend@seerr.dev');
    mock.method(
      userSecurityMutation,
      'runUserSecurityReadWithActor',
      async () => {
        throw new userSecurityMutation.UserMutationActorUnauthorizedError();
      }
    );

    const res = await agent.get(chaptersPath());

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.body, {
      status: 403,
      message: 'Access denied.',
    });
  });
});

describe('manga chapters through the OpenAPI contract', () => {
  it('returns a documented page, unknown numbers and dates included', async () => {
    const manga = downloadedManga(21, [1, 2]);
    manga.chapters.push({
      id: 2190,
      url: `${FAKE_URL_PREFIX}manga-21/extra`,
      chapterNumber: -1,
      uploadDate: 0,
      isDownloaded: false,
    });
    await start(manga);
    await seedDeliveredRequest(manga, { numbers: [1, 2] });

    const res = await request(createContractApp()).get(
      chaptersPath('?pageSize=100')
    );

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.inLibrary, true);
    assert.deepStrictEqual(
      res.body.results.map(
        ({ number, uploadedAt }: { number: number; uploadedAt: unknown }) => [
          number,
          uploadedAt === null,
        ]
      ),
      [
        [2, false],
        [1, false],
        [null, true],
      ]
    );
    assert.ok(res.body.results[0].download);
  });

  it('rejects paging outside the documented bounds before the route', async () => {
    const app = createContractApp({ validateResponses: false });

    for (const query of [
      '?page=0',
      '?page=10001',
      '?pageSize=0',
      '?pageSize=101',
    ]) {
      const res = await request(app).get(chaptersPath(query));
      assert.strictEqual(res.status, 400, query);
    }
    assert.strictEqual(getDetails.mock.callCount(), 0);
  });
});

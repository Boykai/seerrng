import AnilistAPI from '@server/api/anilist';
import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import SuwayomiAPI from '@server/api/suwayomi';
import {
  MangaAttentionCode,
  MangaRequestCheckpoint,
} from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import type MangaRequestManifest from '@server/entity/MangaRequestManifest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MediaRequestStatusEvent from '@server/entity/MediaRequestStatusEvent';
import { User } from '@server/entity/User';
import * as mangaDownloadCopy from '@server/lib/mangaDownloadCopy';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import * as requestDownloadAssets from '@server/lib/requestDownloadAssets';
import * as requestStatus from '@server/lib/requestStatus';
import {
  RequestStatusStage,
  type RequestStatusSnapshot,
} from '@server/lib/requestStatus';
import { getSettings, type SuwayomiSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import {
  FAKE_TITLE_PREFIX,
  dispatchInstanceFor,
  fakeDispatchChapters,
  fakeDispatchManga,
  type FakeDispatchManga,
} from '@server/test/fakeSuwayomiDispatch';
import {
  startFakeProgressSuwayomi,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
import {
  DOWNLOAD_TITLE,
  archiveGets,
  archivePath,
  archiveReply,
  assertPrivateLogs,
  captureLogs,
  deliver,
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
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';

setupTestDb();

const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const fakes: FakeProgressSuwayomi[] = [];
let app: Express;
let server: http.Server;
let origin: string;
let logs: CapturedLog[] = [];

const NOT_FOUND = { status: 404, message: 'Download copy not found.' };
const UNAVAILABLE = {
  status: 502,
  message: 'Unable to download this chapter right now.',
};

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
      cookie: { secure: 'auto' },
      resave: false,
      saveUninitialized: false,
    })
  );
  created.use(rateLimit({ windowMs: 60_000, limit: 10_000 }), checkUser);
  created.use('/auth', authRoutes);
  created.use('/request', requestRoutes);
  created.use(errorHandler);
  return created;
};

const details = (anilistId: number): AnilistMangaDetails => ({
  id: anilistId,
  titles: { english: DOWNLOAD_TITLE },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  tags: [],
  staff: [],
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

/** The session cookie of a seeded user. */
const cookieFor = async (email: string): Promise<string> => {
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;
  try {
    const response = await request(app)
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(response.status, 200);
    const cookies: string[] = ([] as string[]).concat(
      response.headers['set-cookie'] ?? []
    );
    return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
};

/** Gives the demo user `permissions` and signs it in. */
const demoWith = async (permissions: number): Promise<string> => {
  await getRepository(User).update(3, { permissions });
  return cookieFor('demo@seerr.dev');
};

interface RawReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** False when the connection closed before the body ended. */
  complete: boolean;
}

/** One request on its own connection, read until the connection closes. */
const send = (
  target: string,
  cookie: string,
  {
    method = 'GET',
    headers = {},
  }: { method?: string; headers?: Record<string, string> } = {}
): Promise<RawReply> =>
  new Promise((resolve, reject) => {
    const outgoing = http.request(
      `${origin}${target}`,
      { method, agent: false, headers: { Cookie: cookie, ...headers } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', () => undefined);
        incoming.on('close', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            complete: incoming.complete,
          })
        );
      }
    );
    outgoing.on('error', reject);
    outgoing.end();
  });

/** A download whose headers arrived, its body left unread. */
const hold = (
  target: string,
  cookie: string
): Promise<{ status: number; cancel: () => void }> =>
  new Promise((resolve, reject) => {
    const outgoing = http.request(
      `${origin}${target}`,
      { agent: false, headers: { Cookie: cookie } },
      (incoming) => {
        incoming.on('error', () => undefined);
        resolve({
          status: incoming.statusCode ?? 0,
          cancel: () => outgoing.destroy(),
        });
      }
    );
    outgoing.on('error', reject);
    outgoing.end();
  });

const listPath = (requestId: number) =>
  `/request/status/${requestId}/downloads`;
const copyPath = (requestId: number, assetId: string) =>
  `${listPath(requestId)}/${assetId}`;

/** The listed copies of a request: names in order, then their IDs. */
const list = async (requestId: number, cookie: string) => {
  const reply = await send(listPath(requestId), cookie);
  assert.strictEqual(reply.status, 200, reply.body);
  const { results } = JSON.parse(reply.body) as {
    results: { id: string; name: string; size?: number }[];
  };
  return results;
};

const bodyOf = (reply: RawReply): unknown => JSON.parse(reply.body);

/**
 * A request for manga 21, chapters 1 and 2 verified, and chapter 2's archive
 * served with `reply` (a small CBZ by default).
 */
const seedChapters = async (
  options: Parameters<typeof seedDeliveredRequest>[1] = {},
  reply = archiveReply('chapter two bytes')
) => {
  const manga = downloadedManga(21, [1, 2]);
  const fake = await start(manga);
  const seeded = await seedDeliveredRequest(manga, options);
  serveArchive(fake, 2102, reply);
  return { manga, fake, ...seeded };
};

/** The ID of the listed copy of chapter 2, the newest. */
const newestCopy = async (requestId: number, cookie: string) => {
  const [newest] = await list(requestId, cookie);
  assert.strictEqual(newest?.name, 'Sample Manga - Ch. 2.cbz');
  return newest.id;
};

before(async () => {
  app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  configure();
  logs = captureLogs();
  mock.method(
    AnilistAPI.prototype,
    'getMangaDetails',
    async (anilistId: number) => details(anilistId)
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
    settings.main.enabledMediaCategories = categories;
    configure();
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

describe('manga request download copies', () => {
  it('streams a verified chapter from Suwayomi as a private CBZ attachment', async () => {
    const { fake, request: seeded } = await seedChapters({
      mediaStatus: MediaStatus.AVAILABLE,
    });
    const friend = await cookieFor('friend@seerr.dev');

    const listed = await list(seeded.id, friend);

    assert.deepStrictEqual(
      listed.map(({ name }) => name),
      ['Sample Manga - Ch. 2.cbz', 'Sample Manga - Ch. 1.cbz']
    );
    assert.ok(listed.every((copy) => !('size' in copy)));
    // Listing never contacts Suwayomi.
    assert.deepStrictEqual(fake.server.requests, []);

    const reply = await send(copyPath(seeded.id, listed[0].id), friend);

    assert.strictEqual(reply.status, 200);
    assert.strictEqual(reply.body, 'chapter two bytes');
    assert.strictEqual(
      reply.headers['content-disposition'],
      `attachment; filename="Sample Manga - Ch. 2.cbz"; filename*=UTF-8''Sample%20Manga%20-%20Ch.%202.cbz`
    );
    assert.strictEqual(reply.headers['cache-control'], 'private, no-store');
    assert.strictEqual(reply.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(
      reply.headers['content-type'],
      'application/octet-stream'
    );
    assert.strictEqual(reply.headers['content-length'], '17');
    assert.strictEqual(reply.headers['accept-ranges'], undefined);
    assert.deepStrictEqual(fake.operationNames(), [
      'ByNaturalKey',
      'DownloadedChapters',
    ]);
    // One archive GET with no query: Suwayomi marks nothing read.
    assert.deepStrictEqual(
      archiveGets(fake).map(({ url }) => url),
      [archivePath(2102)]
    );
    assert.deepStrictEqual(fake.headIds(), []);
  });

  it('offers manga chapters while the request downloads, has failed or is available, and nothing in any other stage', async () => {
    const { fake, request: seeded } = await seedChapters();
    const friend = await cookieFor('friend@seerr.dev');
    let stage = RequestStatusStage.AVAILABLE;
    mock.method(
      requestStatus,
      'recordRequestStatus',
      async () => ({ stage }) as RequestStatusSnapshot
    );
    const assetId = await newestCopy(seeded.id, friend);
    const offered = [
      RequestStatusStage.DOWNLOADING,
      RequestStatusStage.FAILED,
      RequestStatusStage.AVAILABLE,
    ];

    for (const value of Object.values(RequestStatusStage)) {
      stage = value;
      const before = fake.server.requests.length;
      const listed = await list(seeded.id, friend);
      const reply = await send(copyPath(seeded.id, assetId), friend);

      if (offered.includes(value)) {
        assert.strictEqual(listed.length, 2, value);
        assert.strictEqual(reply.status, 200, value);
        assert.strictEqual(reply.body, 'chapter two bytes', value);
      } else {
        assert.deepStrictEqual(listed, [], value);
        assert.strictEqual(reply.status, 404, value);
        assert.deepStrictEqual(bodyOf(reply), NOT_FOUND, value);
        assert.strictEqual(fake.server.requests.length, before, value);
      }
    }
    assert.strictEqual(archiveGets(fake).length, offered.length);
  });

  it('derives the stage from the request itself, offering chapters only while it downloads, has failed or is available', async () => {
    const enqueued = MangaRequestCheckpoint.CHAPTERS_ENQUEUED;
    const cases: {
      stage: RequestStatusStage;
      status?: MediaRequestStatus;
      manifest?: Partial<MangaRequestManifest>;
      stored?: RequestStatusStage;
    }[] = [
      {
        stage: RequestStatusStage.DOWNLOADING,
        manifest: {
          checkpoint: enqueued,
          chaptersTotal: 3,
          chaptersVerified: 2,
        },
      },
      {
        // A stored event, even the newest, never decides a manga stage.
        stage: RequestStatusStage.DOWNLOADING,
        stored: RequestStatusStage.APPROVED,
        manifest: {
          checkpoint: enqueued,
          chaptersTotal: 3,
          chaptersVerified: 2,
        },
      },
      {
        stage: RequestStatusStage.FAILED,
        manifest: {
          checkpoint: enqueued,
          chaptersTotal: 3,
          chaptersVerified: 2,
          attentionCode: MangaAttentionCode.CHAPTER_ERROR,
        },
      },
      { stage: RequestStatusStage.FAILED, status: MediaRequestStatus.FAILED },
      {
        stage: RequestStatusStage.AVAILABLE,
        manifest: {
          checkpoint: enqueued,
          chaptersTotal: 2,
          chaptersVerified: 2,
        },
      },
      {
        stage: RequestStatusStage.AVAILABLE,
        status: MediaRequestStatus.COMPLETED,
      },
      { stage: RequestStatusStage.APPROVED, manifest: { checkpoint: null } },
      {
        stage: RequestStatusStage.SEARCHING,
        manifest: { checkpoint: MangaRequestCheckpoint.BINDING_VERIFIED },
      },
      {
        stage: RequestStatusStage.REQUESTED,
        status: MediaRequestStatus.PENDING,
        manifest: { checkpoint: null },
      },
      {
        stage: RequestStatusStage.DECLINED,
        status: MediaRequestStatus.DECLINED,
      },
    ];
    const offered: readonly RequestStatusStage[] = [
      RequestStatusStage.DOWNLOADING,
      RequestStatusStage.FAILED,
      RequestStatusStage.AVAILABLE,
    ];
    // Chapter 3 is still downloading: only chapters 1 and 2 are verified.
    const mangas = cases.map((_, index) =>
      fakeDispatchManga(31 + index, {
        inLibrary: true,
        chapters: fakeDispatchChapters(31 + index, [1, 2, 3], [1, 2]),
      })
    );
    const fake = await start(...mangas);
    const friend = await cookieFor('friend@seerr.dev');

    for (const [
      index,
      { stage, status, manifest, stored },
    ] of cases.entries()) {
      const manga = mangas[index];
      const label = `${stage} #${index}`;
      const seeded = await seedDeliveredRequest(manga, {
        anilistId: 9101 + index,
        status,
        manifest,
        delivered: false,
      });
      await deliver(
        seeded.rows.filter(({ chapterNumber }) => chapterNumber !== 3)
      );
      if (stored) {
        await getRepository(MediaRequestStatusEvent).insert(
          new MediaRequestStatusEvent({
            requestId: seeded.request.id,
            requestedById: seeded.request.requestedBy.id,
            mediaId: seeded.request.media.id,
            mediaType: seeded.request.type,
            stage: stored,
            attempt: 1,
            fingerprint: `stored-${index}`,
          })
        );
      }
      serveArchive(fake, manga.id * 100 + 2, archiveReply('chapter two bytes'));
      const before = fake.server.requests.length;

      assert.strictEqual(
        (await requestStatus.recordRequestStatus(seeded.request.id))?.stage,
        stage,
        label
      );
      const [copy] = await requestDownloadAssets.listRequestDownloadAssets(
        seeded.request
      );
      assert.strictEqual(copy?.name, 'Sample Manga - Ch. 2.cbz', label);
      const listed = await list(seeded.request.id, friend);
      // Reading the stage and listing never contact Suwayomi.
      assert.strictEqual(fake.server.requests.length, before, label);
      const reply = await send(copyPath(seeded.request.id, copy.id), friend);

      if (offered.includes(stage)) {
        assert.deepStrictEqual(
          listed.map(({ name }) => name),
          ['Sample Manga - Ch. 2.cbz', 'Sample Manga - Ch. 1.cbz'],
          label
        );
        assert.strictEqual(reply.status, 200, label);
        assert.strictEqual(reply.body, 'chapter two bytes', label);
      } else {
        assert.deepStrictEqual(listed, [], label);
        assert.strictEqual(reply.status, 404, label);
        assert.deepStrictEqual(bodyOf(reply), NOT_FOUND, label);
        assert.strictEqual(fake.server.requests.length, before, label);
      }
    }
    assert.strictEqual(archiveGets(fake).length, 6);
  });

  it('keeps other media to available copies only', async () => {
    const media = await getRepository(Media).save(
      new Media({ tmdbId: 990_001, mediaType: MediaType.MOVIE })
    );
    const movie = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await getRepository(User).findOneByOrFail({ id: 2 }),
        is4k: false,
      })
    );
    let stage = RequestStatusStage.DOWNLOADING;
    mock.method(
      requestStatus,
      'recordRequestStatus',
      async () => ({ stage }) as RequestStatusSnapshot
    );
    mock.method(
      requestDownloadAssets,
      'listRequestDownloadAssets',
      async () => [{ id: 'movie-copy', name: 'Movie.mkv', size: 5 }]
    );
    mock.method(
      requestDownloadAssets,
      'openRequestDownloadAsset',
      async () => ({ stream: Readable.from(['movie']), name: 'Movie.mkv' })
    );
    const friend = await cookieFor('friend@seerr.dev');

    assert.deepStrictEqual(await list(movie.id, friend), []);
    const hidden = await send(copyPath(movie.id, 'movie-copy'), friend);
    assert.strictEqual(hidden.status, 404);
    assert.deepStrictEqual(bodyOf(hidden), NOT_FOUND);

    stage = RequestStatusStage.AVAILABLE;
    assert.deepStrictEqual(await list(movie.id, friend), [
      { id: 'movie-copy', name: 'Movie.mkv', size: 5 },
    ]);
    const shown = await send(copyPath(movie.id, 'movie-copy'), friend);
    assert.strictEqual(shown.status, 200);
    assert.strictEqual(shown.body, 'movie');
  });

  it('lets the requester and request managers or viewers download, and nobody else', async () => {
    const { fake, request: seeded } = await seedChapters({
      mediaStatus: MediaStatus.AVAILABLE,
    });
    const assetId = await newestCopy(
      seeded.id,
      await cookieFor('friend@seerr.dev')
    );
    for (const [role, login] of [
      ['requester', () => cookieFor('friend@seerr.dev')],
      ['admin', () => cookieFor('admin@seerr.dev')],
      [
        'request manager',
        () => demoWith(Permission.REQUEST | Permission.MANAGE_REQUESTS),
      ],
      [
        'request viewer',
        () => demoWith(Permission.REQUEST | Permission.REQUEST_VIEW),
      ],
    ] as const) {
      const cookie = await login();
      assert.strictEqual((await list(seeded.id, cookie)).length, 2, role);
      const reply = await send(copyPath(seeded.id, assetId), cookie);
      assert.strictEqual(reply.status, 200, role);
      assert.strictEqual(reply.body, 'chapter two bytes', role);
    }

    const stranger = await demoWith(Permission.REQUEST);
    const requests = fake.server.requests.length;
    for (const target of [listPath(seeded.id), copyPath(seeded.id, assetId)]) {
      const reply = await send(target, stranger);
      assert.strictEqual(reply.status, 403);
      assert.deepStrictEqual(bodyOf(reply), {
        status: 403,
        message: 'Access denied.',
      });
    }
    assert.strictEqual(fake.server.requests.length, requests);
  });

  it('answers 404 when Suwayomi no longer has the chapter, and before Suwayomi for an unknown or missing copy', async () => {
    const {
      fake,
      manga,
      manifest,
      request: seeded,
    } = await seedChapters({ mediaStatus: MediaStatus.AVAILABLE });
    const friend = await cookieFor('friend@seerr.dev');
    const assetId = await newestCopy(seeded.id, friend);

    for (const status of [400, 404]) {
      serveArchive(fake, 2102, { status, body: `${FAKE_TITLE_PREFIX} gone` });
      const reply = await send(copyPath(seeded.id, assetId), friend);
      assert.strictEqual(reply.status, 404, String(status));
      assert.deepStrictEqual(bodyOf(reply), NOT_FOUND);
    }
    assert.strictEqual(archiveGets(fake).length, 2);

    manga.chapters[1].isDownloaded = false;
    const undownloaded = await send(copyPath(seeded.id, assetId), friend);
    assert.strictEqual(undownloaded.status, 404);
    assert.strictEqual(archiveGets(fake).length, 2);

    const requests = fake.server.requests.length;
    for (const unknown of ['not-a-copy', 'A'.repeat(43)]) {
      const reply = await send(copyPath(seeded.id, unknown), friend);
      assert.strictEqual(reply.status, 404, unknown);
      assert.deepStrictEqual(bodyOf(reply), NOT_FOUND);
    }
    // The poll found the file gone after the listing was shown.
    await getRepository(MangaRequestChapter).update(
      { manifestId: manifest.id },
      { missingSince: new Date() }
    );
    const missing = await send(copyPath(seeded.id, assetId), friend);
    assert.strictEqual(missing.status, 404);
    assert.deepStrictEqual(bodyOf(missing), NOT_FOUND);
    assert.strictEqual(fake.server.requests.length, requests);
    assert.deepStrictEqual(
      logsOf(logs, 'Unable to open a manga download copy'),
      []
    );
  });

  it('answers 502 with a fixed message when Suwayomi fails, logging codes only', async () => {
    const { fake, request: seeded } = await seedChapters(
      { mediaStatus: MediaStatus.AVAILABLE },
      { status: 503, body: `${FAKE_TITLE_PREFIX} upstream detail` }
    );
    const friend = await cookieFor('friend@seerr.dev');
    const assetId = await newestCopy(seeded.id, friend);
    const target = copyPath(seeded.id, assetId);

    const failed = await send(target, friend);
    assert.strictEqual(failed.status, 502);
    assert.deepStrictEqual(bodyOf(failed), UNAVAILABLE);
    assert.deepStrictEqual(
      logsOf(logs, 'Unable to open a manga download copy'),
      [
        [
          'warn',
          {
            label: 'Request Downloads',
            requestId: seeded.id,
            instanceId: 1,
            code: 'HTTP_ERROR',
            operation: 'ChapterArchive',
            httpStatus: 503,
          },
        ],
      ]
    );

    fake.failNext('ByNaturalKey');
    const lookup = await send(target, friend);
    assert.strictEqual(lookup.status, 502);
    assert.deepStrictEqual(bodyOf(lookup), UNAVAILABLE);

    serveArchive(fake, 2102, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': '2147483648',
      },
      chunks: ['x'],
      stallAfterChunks: 1,
    });
    const large = await send(target, friend);
    assert.strictEqual(large.status, 502);
    assert.deepStrictEqual(bodyOf(large), {
      status: 502,
      message: 'This chapter is larger than the download size limit.',
    });

    await fake.close();
    const unreachable = await send(target, friend);
    assert.strictEqual(unreachable.status, 502);
    assert.deepStrictEqual(bodyOf(unreachable), UNAVAILABLE);

    assert.deepStrictEqual(
      logsOf(logs, 'Unable to open a manga download copy').map(
        ([level, { code, operation }]) => [level, code, operation]
      ),
      [
        ['warn', 'HTTP_ERROR', 'ChapterArchive'],
        ['warn', 'UPSTREAM_ERROR', 'ByNaturalKey'],
        ['warn', 'RESPONSE_TOO_LARGE', 'ChapterArchive'],
        ['warn', 'UNREACHABLE', 'ByNaturalKey'],
      ]
    );
  });

  it('answers 500 with a fixed message for an unexpected failure, logging its name only', async () => {
    const { request: seeded } = await seedChapters({
      mediaStatus: MediaStatus.AVAILABLE,
    });
    const friend = await cookieFor('friend@seerr.dev');
    const assetId = await newestCopy(seeded.id, friend);
    mock.method(SuwayomiAPI.prototype, 'findMangaByNaturalKey', async () => {
      throw new TypeError(`${FAKE_TITLE_PREFIX} broke`);
    });

    const reply = await send(copyPath(seeded.id, assetId), friend);

    assert.strictEqual(reply.status, 500);
    assert.deepStrictEqual(bodyOf(reply), {
      status: 500,
      message: 'Unable to download this copy.',
    });
    assert.deepStrictEqual(
      logsOf(logs, 'Something went wrong streaming a manga download copy'),
      [
        [
          'error',
          {
            label: 'Request Downloads',
            requestId: seeded.id,
            instanceId: 1,
            errorName: 'TypeError',
          },
        ],
      ]
    );
  });

  it('sends the whole archive whatever range is asked for, and no length when Suwayomi gives none', async () => {
    const { fake, request: seeded } = await seedChapters(
      { mediaStatus: MediaStatus.AVAILABLE },
      archiveReply('chapter two bytes', false)
    );
    const friend = await cookieFor('friend@seerr.dev');
    const assetId = await newestCopy(seeded.id, friend);

    const reply = await send(copyPath(seeded.id, assetId), friend, {
      headers: { Range: 'bytes=0-3' },
    });

    assert.strictEqual(reply.status, 200);
    assert.strictEqual(reply.body, 'chapter two bytes');
    assert.strictEqual(reply.headers['content-range'], undefined);
    assert.strictEqual(reply.headers['content-length'], undefined);
    assert.strictEqual(reply.headers['transfer-encoding'], 'chunked');
    const [get] = archiveGets(fake);
    assert.strictEqual(get.headers.range, undefined);
  });

  it('runs two downloads per user and four per server, answering 429 before Suwayomi beyond them', async () => {
    const { fake, request: seeded } = await seedChapters(
      { mediaStatus: MediaStatus.AVAILABLE },
      {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
        chunks: ['first', 'second'],
        stallAfterChunks: 1,
      }
    );
    const friend = await cookieFor('friend@seerr.dev');
    const admin = await cookieFor('admin@seerr.dev');
    const viewer = await demoWith(Permission.REQUEST | Permission.REQUEST_VIEW);
    const target = copyPath(seeded.id, await newestCopy(seeded.id, friend));
    const busy = {
      status: 429,
      message: 'Too many downloads are running. Try again shortly.',
    };

    const held = [await hold(target, friend), await hold(target, friend)];
    let requests = fake.server.requests.length;
    const third = await send(target, friend);
    assert.strictEqual(third.status, 429);
    assert.strictEqual(third.headers['retry-after'], '30');
    assert.deepStrictEqual(bodyOf(third), busy);
    assert.strictEqual(fake.server.requests.length, requests);

    held.push(await hold(target, admin), await hold(target, admin));
    requests = fake.server.requests.length;
    const fifth = await send(target, viewer);
    assert.strictEqual(fifth.status, 429);
    assert.strictEqual(fifth.headers['retry-after'], '30');
    assert.deepStrictEqual(bodyOf(fifth), busy);
    assert.strictEqual(fake.server.requests.length, requests);
    assert.deepStrictEqual(
      held.map(({ status }) => status),
      [200, 200, 200, 200]
    );

    for (const download of held) download.cancel();
    await slotsReleased();
    const gets = archiveGets(fake);
    assert.strictEqual(gets.length, 4);
    // Leaving cancels each Suwayomi request before its archive ended.
    assert.deepStrictEqual(
      await Promise.all(gets.map(({ closed }) => closed)),
      [false, false, false, false]
    );
    assert.deepStrictEqual(logsOf(logs, 'Stopped a manga download copy'), []);
  });

  it('logs a download that Suwayomi cut short, and ends the response unfinished', async () => {
    const { request: seeded } = await seedChapters(
      { mediaStatus: MediaStatus.AVAILABLE },
      {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
        chunks: ['first', 'second'],
        // Lets the first chunk reach SeerrNG before the connection drops.
        chunkDelayMs: 50,
        dropAfterChunks: 1,
      }
    );
    const friend = await cookieFor('friend@seerr.dev');
    const assetId = await newestCopy(seeded.id, friend);

    const reply = await send(copyPath(seeded.id, assetId), friend);

    assert.strictEqual(reply.status, 200);
    assert.strictEqual(reply.complete, false);
    // The route logs after the client sees the cut, then frees its slot.
    await slotsReleased();
    const stopped = logsOf(logs, 'Stopped a manga download copy');
    assert.strictEqual(stopped.length, 1);
    const [[level, meta]] = stopped;
    assert.strictEqual(level, 'warn');
    assert.deepStrictEqual(
      [meta.label, meta.requestId, meta.instanceId, meta.operation, meta.code],
      ['Request Downloads', seeded.id, 1, 'ChapterArchive', 'UNREACHABLE']
    );
  });

  it('stops a download once nothing flows for the stall time, logging the limit', async () => {
    const { fake, request: seeded } = await seedChapters(
      { mediaStatus: MediaStatus.AVAILABLE },
      {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
        chunks: ['first', 'second'],
        stallAfterChunks: 1,
      }
    );
    const guard = mangaDownloadCopy.guardMangaDownload;
    mock.method(
      mangaDownloadCopy,
      'guardMangaDownload',
      (...[source, target]: Parameters<typeof guard>) =>
        guard(source, target, { stallMs: 100 })
    );
    const friend = await cookieFor('friend@seerr.dev');
    const assetId = await newestCopy(seeded.id, friend);

    const reply = await send(copyPath(seeded.id, assetId), friend);

    assert.strictEqual(reply.status, 200);
    assert.strictEqual(reply.complete, false);
    await slotsReleased();
    const [archive] = archiveGets(fake);
    assert.strictEqual(await archive?.closed, false);
    const stopped = logsOf(logs, 'Stopped a manga download copy');
    assert.strictEqual(stopped.length, 1);
    const [[level, meta]] = stopped;
    assert.strictEqual(level, 'warn');
    assert.deepStrictEqual(
      [meta.label, meta.requestId, meta.instanceId, meta.code],
      ['Request Downloads', seeded.id, 1, 'STALLED']
    );
  });

  it('answers HEAD from its own checks without asking Suwayomi', async () => {
    const { fake, request: seeded } = await seedChapters({
      mediaStatus: MediaStatus.AVAILABLE,
    });
    const friend = await cookieFor('friend@seerr.dev');
    const assetId = await newestCopy(seeded.id, friend);

    const reply = await send(copyPath(seeded.id, assetId), friend, {
      method: 'HEAD',
    });

    assert.strictEqual(reply.status, 200);
    assert.strictEqual(reply.body, '');
    assert.match(
      String(reply.headers['content-disposition']),
      /^attachment; filename="Sample Manga - Ch\. 2\.cbz"/
    );
    assert.deepStrictEqual(fake.server.requests, []);
  });
});

describe('the request download contract', () => {
  it('admits GET and refuses HEAD with 405 before any route runs', async () => {
    const validated = express();
    validated.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    let reached = 0;
    validated.get(
      '/api/v1/request/status/:requestId/downloads/:assetId',
      (_req, res) => {
        reached += 1;
        res.status(200).end();
      }
    );
    validated.use(errorHandler);
    const target = '/api/v1/request/status/31/downloads/asset';

    assert.strictEqual((await request(validated).head(target)).status, 405);
    assert.strictEqual(reached, 0);
    assert.strictEqual((await request(validated).get(target)).status, 200);
    assert.strictEqual(reached, 1);
  });
});

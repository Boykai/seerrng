import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import AnilistAPI from '@server/api/anilist';
import {
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist/failures';
import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import ExternalAPI from '@server/api/externalapi';
import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  QuotaRestrictedError,
  ServiceConfigurationError,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { NotFoundError, Watchlist } from '@server/entity/Watchlist';
import { createMangaMedia } from '@server/lib/mangaMedia';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import requestDispatchManager from '@server/lib/requestDispatch';
import { getSettings, type SuwayomiSettings } from '@server/lib/settings';
import { getCombinedWatchlist } from '@server/lib/watchlist';
import { checkUser } from '@server/middleware/auth';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import type { Express } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import mangaRoutes from './manga';
import watchlistRoutes from './watchlist';

const TITLE = 900001;

const suwayomi = (id: number, isDefault = false): SuwayomiSettings => ({
  id,
  name: `Suwayomi ${id}`,
  hostname: 'localhost',
  port: 4567,
  useSsl: false,
  baseUrl: '',
  isDefault,
  authMode: 'NONE',
  username: '',
  password: '',
  sourceAllowlist: [],
  preferredLanguages: [],
  scanlatorPreference: [],
  requireCbz: true,
});

const details = (
  overrides: Partial<AnilistMangaDetails> = {}
): AnilistMangaDetails => ({
  id: TITLE,
  titles: { english: 'Sample Manga' },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  tags: [],
  staff: [],
  ...overrides,
});

let app: Express;
let catalog: Map<number, AnilistMangaDetails | null | Error>;
let anilistCalls: number[];
let externalCalls: string[];
let enqueued: number[];
let savedSuwayomi: SuwayomiSettings[];
let savedCategories: ReturnType<
  typeof getSettings
>['main']['enabledMediaCategories'];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    // Test-only session middleware has no network listener or real secret.
    // codeql[js/clear-text-cookie]
    session({
      secret: 'test-secret',
      cookie: { secure: 'auto' },
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(rateLimit({ windowMs: 60_000, limit: 10_000 }), checkUser);
  app.use('/auth', authRoutes);
  app.use('/watchlist', watchlistRoutes);
  app.use('/manga', mangaRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

const setMangaEnabled = (manga: boolean) => {
  getSettings().main.enabledMediaCategories = { ...savedCategories, manga };
};

before(() => {
  app = createApp();
});

beforeEach(() => {
  const settings = getSettings();
  savedSuwayomi = settings.suwayomi;
  savedCategories = settings.main.enabledMediaCategories;
  settings.suwayomi = [suwayomi(1, true)];
  setMangaEnabled(true);

  catalog = new Map();
  anilistCalls = [];
  mock.method(
    AnilistAPI.prototype,
    'getMangaDetails',
    async (anilistId: number) => {
      anilistCalls.push(anilistId);
      const entry = catalog.get(anilistId);
      if (entry instanceof Error) throw entry;
      return entry === undefined ? details({ id: anilistId }) : entry;
    }
  );
  externalCalls = [];
  mock.method(
    ExternalAPI.prototype as unknown as {
      get: (endpoint: string) => Promise<unknown>;
    },
    'get',
    async (endpoint: string) => {
      externalCalls.push(endpoint);
      throw new Error(`Unstubbed external endpoint: ${endpoint}`);
    }
  );
  mock.method(notificationManager, 'sendNotificationIntent', async () => {
    return;
  });
  enqueued = [];
  mock.method(requestDispatchManager, 'enqueue', async (requestId: number) => {
    enqueued.push(requestId);
  });
  mock.method(
    MediaRequestSubscriber.prototype,
    'dispatchRequestById',
    async () => ({ delivered: true })
  );
});

afterEach(async () => {
  await waitForBackgroundTasks();
  mock.restoreAll();
  const settings = getSettings();
  settings.suwayomi = savedSuwayomi;
  settings.main.enabledMediaCategories = savedCategories;
  assert.deepStrictEqual(externalCalls, []);
});

setupTestDb();

async function loginAs(email: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

const findUser = (email: string) =>
  getRepository(User).findOneOrFail({ where: { email } });

// Updates a seeded user's permissions, quotas or manga watchlist setting.
const configureUser = async (
  email: string,
  init: Partial<User>,
  watchlistSyncManga?: boolean
): Promise<User> => {
  const user = await findUser(email);
  Object.assign(user, init);
  if (watchlistSyncManga !== undefined) {
    user.settings = new UserSettings({ watchlistSyncManga });
  }
  return getRepository(User).save(user);
};

const createUser = (
  email: string,
  permissions: number,
  watchlistSyncManga: boolean
): Promise<User> =>
  getRepository(User).save(
    new User({
      email,
      permissions,
      avatar: '',
      settings: new UserSettings({ watchlistSyncManga }),
    })
  );

const addManga = (user: User, externalId: string | number = TITLE) =>
  Watchlist.createWatchlist({
    watchlistRequest: {
      mediaType: MediaType.MANGA,
      externalId: String(externalId),
    },
    user,
  });

const mangaWatchlistRows = () =>
  getRepository(Watchlist).find({
    where: { mediaType: MediaType.MANGA },
    order: { id: 'ASC' },
  });

const mangaRequests = () =>
  getRepository(MediaRequest).find({
    where: { type: MediaType.MANGA },
    relations: { media: true, requestedBy: true },
    order: { id: 'ASC' },
  });

describe('manga watchlist items', () => {
  it('adds a manga by its AniList ID with the catalog title and canonical media', async () => {
    catalog.set(
      30013,
      details({ id: 30013, titles: { romaji: 'Romaji Title' } })
    );
    const friend = await loginAs('friend@seerr.dev');

    const created = await friend.post('/watchlist').send({
      mediaType: MediaType.MANGA,
      externalId: ' 030013 ',
      title: 'Client title',
    });

    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body.mediaType, MediaType.MANGA);
    assert.strictEqual(created.body.externalId, '30013');
    assert.strictEqual(created.body.title, 'Romaji Title');
    assert.deepStrictEqual(anilistCalls, [30013]);

    const [row] = await mangaWatchlistRows();
    assert.strictEqual(row.externalId, '30013');
    assert.strictEqual(row.media.mediaType, MediaType.MANGA);
    assert.strictEqual(row.media.status, MediaStatus.UNKNOWN);
    const identifier = await getRepository(MediaIdentifier).findOneOrFail({
      where: { media: { id: row.media.id } },
    });
    assert.strictEqual(identifier.provider, MediaIdentifierProvider.ANILIST);
    assert.strictEqual(identifier.value, '30013');
    assert.strictEqual(identifier.canonical, true);

    const duplicate = await friend
      .post('/watchlist')
      .send({ mediaType: MediaType.MANGA, externalId: '30013' });
    assert.strictEqual(duplicate.status, 409);

    // Another user's item shares the title's media.
    const admin = await loginAs('admin@seerr.dev');
    const shared = await admin
      .post('/watchlist')
      .send({ mediaType: MediaType.MANGA, externalId: '30013' });
    assert.strictEqual(shared.status, 201);
    const rows = await mangaWatchlistRows();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].media.id, row.media.id);
    assert.strictEqual(
      await getRepository(Media).count({
        where: { mediaType: MediaType.MANGA },
      }),
      1
    );
    assert.strictEqual((await mangaRequests()).length, 0);
  });

  it('answers excluded, unknown and conflicting titles like the details route', async () => {
    catalog.set(900002, details({ id: 900002, isAdult: true }));
    catalog.set(900003, details({ id: 900003, format: 'NOVEL' }));
    catalog.set(900004, null);
    // The AniList ID already belongs to media of another type.
    await getRepository(Media).save(
      new Media({
        tmdbId: 0,
        mediaType: MediaType.BOOK,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
        identifiers: [
          new MediaIdentifier({
            provider: MediaIdentifierProvider.ANILIST,
            value: '900005',
            canonical: false,
          }),
        ],
      })
    );
    const friend = await loginAs('friend@seerr.dev');

    for (const externalId of ['900002', '900003', '900004', '900005']) {
      const response = await friend
        .post('/watchlist')
        .send({ mediaType: MediaType.MANGA, externalId });
      assert.strictEqual(response.status, 404, `AniList ${externalId}`);
      assert.deepStrictEqual(response.body, {
        status: 404,
        message: 'Manga not found.',
      });
    }

    assert.deepStrictEqual(await mangaWatchlistRows(), []);
    assert.strictEqual(
      await getRepository(Media).count({
        where: { mediaType: MediaType.MANGA },
      }),
      0
    );
  });

  it('answers 429 with Retry-After when AniList is rate limited and 503 when it is down', async () => {
    catalog.set(900005, new AnilistRateLimitedError(30));
    catalog.set(900006, new AnilistOutageError());
    const friend = await loginAs('friend@seerr.dev');

    const limited = await friend
      .post('/watchlist')
      .send({ mediaType: MediaType.MANGA, externalId: '900005' });
    const down = await friend
      .post('/watchlist')
      .send({ mediaType: MediaType.MANGA, externalId: '900006' });

    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.headers['retry-after'], '30');
    assert.strictEqual(down.status, 503);
    assert.strictEqual(down.body.message, 'Unable to retrieve manga details.');
    assert.deepStrictEqual(await mangaWatchlistRows(), []);
  });

  it('rejects invalid AniList IDs before any AniList call', async () => {
    const friend = await loginAs('friend@seerr.dev');

    for (const body of [
      { mediaType: MediaType.MANGA, externalId: 'abc' },
      { mediaType: MediaType.MANGA, externalId: '0' },
      { mediaType: MediaType.MANGA, externalId: '1000000001' },
      { mediaType: MediaType.MANGA, tmdbId: TITLE },
    ]) {
      const response = await friend.post('/watchlist').send(body);
      assert.strictEqual(response.status, 400, JSON.stringify(body));
      assert.strictEqual(response.body.message, 'Invalid watchlist payload.');
    }
    const badDelete = await friend.delete('/watchlist/abc?mediaType=manga');
    assert.strictEqual(badDelete.status, 400);

    await assert.rejects(
      addManga(await findUser('friend@seerr.dev'), 'abc'),
      /AniList ID is invalid/
    );
    assert.deepStrictEqual(anilistCalls, []);
  });

  it('deletes manga watchlist items by AniList ID', async () => {
    const friend = await findUser('friend@seerr.dev');
    await addManga(friend);
    const agent = await loginAs(friend.email);

    const removed = await agent.delete(`/watchlist/0${TITLE}?mediaType=manga`);
    const missing = await agent.delete(`/watchlist/${TITLE}?mediaType=manga`);

    assert.strictEqual(removed.status, 204);
    assert.deepStrictEqual(await mangaWatchlistRows(), []);
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body.message, 'Watchlist item not found.');
  });

  it('hides manga watchlist items while the manga category is disabled', async () => {
    const friend = await findUser('friend@seerr.dev');
    await addManga(friend);
    const agent = await loginAs(friend.email);
    const listed = await getCombinedWatchlist({
      userId: friend.id,
      page: 1,
      itemsPerPage: 20,
    });
    assert.strictEqual(listed.totalResults, 1);
    assert.deepStrictEqual(
      listed.results.map(({ mediaType, externalId, title }) => ({
        mediaType,
        externalId,
        title,
      })),
      [
        {
          mediaType: MediaType.MANGA,
          externalId: String(TITLE),
          title: 'Sample Manga',
        },
      ]
    );
    anilistCalls = [];

    setMangaEnabled(false);
    const created = await agent
      .post('/watchlist')
      .send({ mediaType: MediaType.MANGA, externalId: '900002' });
    const invalid = await agent
      .post('/watchlist')
      .send({ mediaType: MediaType.MANGA, externalId: 'abc' });
    const removed = await agent.delete(`/watchlist/${TITLE}?mediaType=manga`);
    const hidden = await getCombinedWatchlist({
      userId: friend.id,
      page: 1,
      itemsPerPage: 20,
    });

    for (const response of [created, invalid, removed]) {
      assert.strictEqual(response.status, 404);
      assert.deepStrictEqual(response.body, {
        status: 404,
        message: 'Not found.',
      });
    }
    await assert.rejects(addManga(friend, 900003), NotFoundError);
    assert.strictEqual(hidden.totalResults, 0);
    assert.deepStrictEqual(hidden.results, []);
    assert.deepStrictEqual(anilistCalls, []);
    assert.strictEqual((await mangaWatchlistRows()).length, 1);
  });

  it("reports onUserWatchlist on manga details for the item's owner only", async () => {
    await addManga(await findUser('friend@seerr.dev'));
    const friend = await loginAs('friend@seerr.dev');
    const admin = await loginAs('admin@seerr.dev');

    const owner = await friend.get(`/manga/${TITLE}`);
    const other = await admin.get(`/manga/${TITLE}`);

    assert.strictEqual(owner.status, 200);
    assert.strictEqual(owner.body.onUserWatchlist, true);
    assert.strictEqual(other.status, 200);
    assert.strictEqual(other.body.onUserWatchlist, false);
  });
});

describe('manga watchlist auto-requests', () => {
  it('requests only with the manga watchlist setting and an auto-request permission', async () => {
    const requestMock = mock.method(
      MediaRequest,
      'request',
      async () => new MediaRequest()
    );
    const cases: [string, number, boolean, boolean][] = [
      ['setting off', Permission.AUTO_REQUEST_MANGA, false, false],
      ['no auto-request permission', Permission.REQUEST_MANGA, true, false],
      ['another type only', Permission.AUTO_REQUEST_COMIC, true, false],
      ['auto-request', Permission.AUTO_REQUEST, true, true],
      ['manga auto-request', Permission.AUTO_REQUEST_MANGA, true, true],
      ['admin', Permission.ADMIN, true, true],
    ];

    for (const [index, [label, permissions, setting, expected]] of [
      ...cases.entries(),
    ]) {
      const user = await createUser(
        `manga-${index}@seerr.dev`,
        permissions,
        setting
      );
      requestMock.mock.resetCalls();

      await addManga(user);

      assert.strictEqual(requestMock.mock.callCount(), expected ? 1 : 0, label);
      if (expected) {
        const [body, requester, options] = requestMock.mock.calls[0].arguments;
        assert.deepStrictEqual(body, {
          mediaId: TITLE,
          mediaType: MediaType.MANGA,
        });
        assert.strictEqual(requester?.id, user.id, label);
        assert.strictEqual(options?.isAutoRequest, true, label);
      }
    }
    assert.strictEqual((await mangaWatchlistRows()).length, cases.length);
  });

  it('keeps the watchlist item when the auto-request is refused', async () => {
    const refusals = [
      new QuotaRestrictedError('Manga Quota exceeded.'),
      new BlocklistedMediaError('This manga is blocklisted.'),
      new DuplicateMediaRequestError(
        'A request for this manga already exists.'
      ),
      new ServiceConfigurationError(
        'No Suwayomi server is configured for manga requests.'
      ),
      new Error('Unexpected failure'),
    ];
    let next = 0;
    mock.method(MediaRequest, 'request', async () => {
      throw refusals[next++];
    });
    const user = await createUser(
      'manga-refused@seerr.dev',
      Permission.REQUEST_MANGA + Permission.AUTO_REQUEST_MANGA,
      true
    );

    for (const [index] of refusals.entries()) {
      await addManga(user, TITLE + index);
    }

    assert.strictEqual(next, refusals.length);
    assert.deepStrictEqual(
      (await mangaWatchlistRows()).map(({ externalId }) => externalId),
      refusals.map((_, index) => String(TITLE + index))
    );
  });

  it('creates a parked pending request through the manga request path', async () => {
    await configureUser(
      'friend@seerr.dev',
      { permissions: Permission.REQUEST_MANGA + Permission.AUTO_REQUEST_MANGA },
      true
    );
    const friend = await loginAs('friend@seerr.dev');

    const created = await friend
      .post('/watchlist')
      .send({ mediaType: MediaType.MANGA, externalId: String(TITLE) });

    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const [mangaRequest] = await mangaRequests();
    assert.strictEqual(mangaRequest.status, MediaRequestStatus.PENDING);
    assert.strictEqual(mangaRequest.isAutoRequest, true);
    assert.strictEqual(mangaRequest.requestedBy.email, 'friend@seerr.dev');
    assert.strictEqual(mangaRequest.media.status, MediaStatus.PENDING);
    const [row] = await mangaWatchlistRows();
    assert.strictEqual(row.media.id, mangaRequest.media.id);
    const manifest = await getRepository(MangaRequestManifest).findOneOrFail({
      where: { requestId: mangaRequest.id },
    });
    assert.strictEqual(manifest.anilistId, TITLE);
    assert.strictEqual(manifest.instanceId, 1);
    assert.strictEqual(
      manifest.bindingState,
      MangaRequestBindingState.AWAITING_BINDING
    );
    assert.deepStrictEqual(enqueued, []);
    // The watchlist check and the request each look the title up; the
    // shared client serves the second from its cache outside tests.
    assert.deepStrictEqual(anilistCalls, [TITLE, TITLE]);

    // Removing the watchlist item leaves the request alone.
    const removed = await friend.delete(`/watchlist/${TITLE}?mediaType=manga`);
    assert.strictEqual(removed.status, 204);
    const [kept] = await mangaRequests();
    assert.strictEqual(kept.id, mangaRequest.id);
    assert.strictEqual(kept.status, MediaRequestStatus.PENDING);
  });

  it('applies the manga quota and the blocklist to auto-requests', async () => {
    await configureUser(
      'friend@seerr.dev',
      {
        permissions: Permission.REQUEST_MANGA + Permission.AUTO_REQUEST_MANGA,
        mangaQuotaLimit: 1,
        mangaQuotaDays: 7,
      },
      true
    );
    await createMangaMedia(dataSource.manager, 900003, MediaStatus.BLOCKLISTED);
    const friend = await loginAs('friend@seerr.dev');
    const add = (externalId: string) =>
      friend
        .post('/watchlist')
        .send({ mediaType: MediaType.MANGA, externalId });

    const requested = await add(String(TITLE));
    const overQuota = await add('900002');
    await configureUser('friend@seerr.dev', { mangaQuotaLimit: 5 });
    const blocklisted = await add('900003');

    assert.deepStrictEqual(
      [requested, overQuota, blocklisted].map(({ status }) => status),
      [201, 201, 201]
    );
    assert.deepStrictEqual(
      (await mangaWatchlistRows()).map(({ externalId }) => externalId),
      [String(TITLE), '900002', '900003']
    );
    const requests = await mangaRequests();
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].isAutoRequest, true);
    const [requestedTitle] = await getRepository(MediaIdentifier).find({
      where: { media: { id: requests[0].media.id } },
    });
    assert.strictEqual(requestedTitle.value, String(TITLE));
  });
});

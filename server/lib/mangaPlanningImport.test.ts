import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

import AnilistAPI from '@server/api/anilist';
import {
  AnilistAuthError,
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist/failures';
import type {
  AnilistMangaDetails,
  AnilistMangaPlanningEntry,
  AnilistMangaPlanningPage,
} from '@server/api/anilist/manga';
import ExternalAPI from '@server/api/externalapi';
import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import DiscoveryAccount from '@server/entity/DiscoveryAccount';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Watchlist } from '@server/entity/Watchlist';
import { saveDiscoveryAccount } from '@server/lib/discoveryIntegrations/accounts';
import { createMangaMedia } from '@server/lib/mangaMedia';
import {
  mangaPlanningImporter,
  PLANNING_IMPORT_MAX_ADDS,
  PLANNING_IMPORT_RUN_BUDGET,
  runMangaPlanningImport,
} from '@server/lib/mangaPlanningImport';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import requestDispatchManager from '@server/lib/requestDispatch';
import { getSettings, type SuwayomiSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import {
  AxiosError,
  AxiosHeaders,
  CanceledError,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';

const CLIENT_ID = 'planning-import-test';
const PAGE_SIZE = 50;
const LABEL = 'AniList Planning Import';

type LogEntry = [level: string, message: string, meta: Record<string, unknown>];
type Post = (
  endpoint: string,
  data?: Record<string, unknown>,
  config?: AxiosRequestConfig
) => Promise<unknown>;

interface PageRead {
  anilistUserId: number;
  page: number;
  token?: string;
}

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

const details = (id: number): AnilistMangaDetails => ({
  id,
  titles: { english: `Manga ${id}` },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  tags: [],
  staff: [],
});

const entry = (
  anilistId: number,
  updatedAt: number,
  overrides: Partial<AnilistMangaPlanningEntry> = {}
): AnilistMangaPlanningEntry => ({
  anilistId,
  updatedAt,
  format: 'MANGA',
  isAdult: false,
  ...overrides,
});

const range = (start: number, length: number): number[] =>
  Array.from({ length }, (_, index) => start + index);

const tokenOf = (api: AnilistAPI): string | undefined =>
  (api as unknown as { accessToken?: string }).accessToken;

/** Planning lists by AniList user ID, or the error reading one throws. */
let lists: Map<number, AnilistMangaPlanningEntry[] | Error>;
let reads: PageRead[];
/** Runs inside each list read, before it answers. */
let onRead: ((signal?: AbortSignal) => Promise<void>) | undefined;
let pages: { mock: { restore: () => void } };
let catalog: Map<number, AnilistMangaDetails | null | Error>;
let anilistCalls: number[];
let viewer: { id: number; name: string };
let viewerCalls: (string | undefined)[];
let anilistPost: Post;
let unstubbed: string[];
let writes: string[];
let enqueued: number[];
let logs: LogEntry[];
/** Each linked user's AniList token. */
let tokens: Map<number, string>;
let saved: {
  suwayomi: SuwayomiSettings[];
  categories: ReturnType<typeof getSettings>['main']['enabledMediaCategories'];
  clientId: string;
  includeAdult: boolean;
  includeNovels: boolean;
};

const setMangaEnabled = (manga: boolean) => {
  getSettings().main.enabledMediaCategories = {
    ...saved.categories,
    manga,
  };
};

const captureLogs = (): LogEntry[] => {
  const captured: LogEntry[] = [];
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    mock.method(logger, level, (message: unknown, meta?: unknown) => {
      captured.push([
        level,
        String(message),
        (meta ?? {}) as Record<string, unknown>,
      ]);
      return logger;
    });
  }
  return captured;
};

/** The level and metadata of every log line with `message`. */
const logged = (message: string) =>
  logs
    .filter(([, text]) => text === message)
    .map(([level, , meta]) => [level, meta] as const);

beforeEach(() => {
  const settings = getSettings();
  saved = {
    suwayomi: settings.suwayomi,
    categories: settings.main.enabledMediaCategories,
    clientId: settings.discoveryIntegrations.anilist.clientId,
    includeAdult: settings.main.mangaIncludeAdult,
    includeNovels: settings.main.mangaIncludeNovels,
  };
  settings.suwayomi = [suwayomi(1, true)];
  settings.discoveryIntegrations.anilist.clientId = CLIENT_ID;
  settings.main.mangaIncludeAdult = false;
  settings.main.mangaIncludeNovels = false;
  setMangaEnabled(true);

  lists = new Map();
  reads = [];
  onRead = undefined;
  pages = mock.method(
    AnilistAPI.prototype,
    'getMangaPlanningPage',
    async function (
      this: AnilistAPI,
      anilistUserId: number,
      page: number,
      options: { signal?: AbortSignal } = {}
    ): Promise<AnilistMangaPlanningPage> {
      reads.push({ anilistUserId, page, token: tokenOf(this) });
      await onRead?.(options.signal);
      const list = lists.get(anilistUserId) ?? [];
      if (list instanceof Error) throw list;
      const newestFirst = [...list].sort(
        (left, right) =>
          right.updatedAt - left.updatedAt || right.anilistId - left.anilistId
      );
      const start = (page - 1) * PAGE_SIZE;
      return {
        hasNextPage: newestFirst.length > start + PAGE_SIZE,
        entries: newestFirst.slice(start, start + PAGE_SIZE),
      };
    }
  );
  catalog = new Map();
  anilistCalls = [];
  mock.method(
    AnilistAPI.prototype,
    'getMangaDetails',
    async (anilistId: number) => {
      anilistCalls.push(anilistId);
      const found = catalog.get(anilistId);
      if (found instanceof Error) throw found;
      return found === undefined ? details(anilistId) : found;
    }
  );
  viewer = { id: 7999, name: 'viewer' };
  viewerCalls = [];
  mock.method(
    AnilistAPI.prototype,
    'getViewer',
    async function (this: AnilistAPI) {
      viewerCalls.push(tokenOf(this));
      return viewer;
    }
  );
  writes = [];
  for (const method of ['saveMediaListEntry', 'deleteMediaListEntry']) {
    mock.method(
      AnilistAPI.prototype as unknown as Record<string, () => Promise<unknown>>,
      method,
      async () => {
        writes.push(method);
        throw new Error(`Unexpected AniList write: ${method}`);
      }
    );
  }
  unstubbed = [];
  anilistPost = async (endpoint) => {
    unstubbed.push(`POST ${endpoint}`);
    throw new Error('Unstubbed external call');
  };
  mock.method(
    ExternalAPI.prototype as unknown as { post: Post },
    'post',
    (...args: Parameters<Post>) => anilistPost(...args)
  );
  mock.method(
    ExternalAPI.prototype as unknown as {
      get: (endpoint: string) => Promise<unknown>;
    },
    'get',
    async (endpoint: string) => {
      unstubbed.push(`GET ${endpoint}`);
      throw new Error('Unstubbed external call');
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
  logs = captureLogs();
  tokens = new Map();
});

afterEach(async () => {
  await waitForBackgroundTasks();
  mock.restoreAll();
  const settings = getSettings();
  settings.suwayomi = saved.suwayomi;
  settings.main.enabledMediaCategories = saved.categories;
  settings.discoveryIntegrations.anilist.clientId = saved.clientId;
  settings.main.mangaIncludeAdult = saved.includeAdult;
  settings.main.mangaIncludeNovels = saved.includeNovels;
  assert.deepStrictEqual(unstubbed, []);
  // The import only reads from AniList.
  assert.deepStrictEqual(writes, []);
  const logText = inspect(logs, { depth: null });
  for (const token of tokens.values()) {
    assert.strictEqual(logText.includes(token), false, 'A token was logged.');
  }
});

setupTestDb();

const findUser = (email: string) =>
  getRepository(User).findOneByOrFail({ email });

const createUser = (email: string, permissions: number): Promise<User> =>
  getRepository(User).save(
    new User({
      email,
      permissions,
      avatar: '',
      settings: new UserSettings({ watchlistSyncManga: false }),
    })
  );

// Sets a seeded user's permissions and manga watchlist request setting.
const configureUser = async (
  email: string,
  permissions: number,
  watchlistSyncManga: boolean
): Promise<User> => {
  const user = await findUser(email);
  user.permissions = permissions;
  user.settings = new UserSettings({ watchlistSyncManga });
  return getRepository(User).save(user);
};

/** Links an AniList account that imports its Planning list. */
const link = async (
  user: User,
  anilistUserId: number | null,
  overrides: Partial<DiscoveryAccount> = {}
): Promise<void> => {
  const accessToken = randomUUID();
  tokens.set(user.id, accessToken);
  await getRepository(DiscoveryAccount).save({
    userId: user.id,
    provider: 'anilist' as const,
    clientId: CLIENT_ID,
    accessToken,
    username: `reader${user.id}`,
    providerUserId: anilistUserId === null ? '' : String(anilistUserId),
    allowWrites: false,
    importMangaPlanning: true,
    mangaPlanningCursor: null,
    mangaPlanningCursorId: null,
    ...overrides,
  });
};

/** A user's manga watchlist, as AniList IDs in the order they were added. */
const watchlisted = async (user: User): Promise<number[]> =>
  (
    await getRepository(Watchlist).find({
      where: { mediaType: MediaType.MANGA, requestedBy: { id: user.id } },
      order: { id: 'ASC' },
    })
  ).map(({ externalId }) => Number(externalId));

/** The last entry the import handled: its change time and AniList ID. */
const cursorOf = async (user: User): Promise<(number | null)[]> => {
  const account = await getRepository(DiscoveryAccount).findOneByOrFail({
    userId: user.id,
    provider: 'anilist',
  });
  return [account.mangaPlanningCursor, account.mangaPlanningCursorId];
};

const mangaRequests = () =>
  getRepository(MediaRequest).find({
    where: { type: MediaType.MANGA },
    relations: { requestedBy: true },
    order: { id: 'ASC' },
  });

describe('AniList Planning import', () => {
  it('imports Planning manga only for AniList accounts that opted in', async () => {
    const admin = await findUser('admin@seerr.dev');
    const friend = await findUser('friend@seerr.dev');
    const demo = await findUser('demo@seerr.dev');
    await link(admin, 7001);
    await link(friend, 7002, { importMangaPlanning: false });
    await getRepository(DiscoveryAccount).save({
      userId: demo.id,
      provider: 'trakt' as const,
      clientId: 'trakt-app',
      accessToken: randomUUID(),
      providerUserId: '7003',
      importMangaPlanning: true,
    });
    lists.set(7001, [entry(30001, 1000), entry(30002, 1001)]);
    lists.set(7002, [entry(30003, 1000)]);
    lists.set(7003, [entry(30004, 1000)]);

    const counts = await runMangaPlanningImport({ lastUserId: 0 });

    assert.deepStrictEqual(counts, { users: 1, added: 2, skipped: 0 });
    assert.deepStrictEqual(reads, [
      { anilistUserId: 7001, page: 1, token: tokens.get(admin.id) },
    ]);
    assert.deepStrictEqual(await watchlisted(admin), [30001, 30002]);
    assert.deepStrictEqual(await watchlisted(friend), []);
    assert.deepStrictEqual(await watchlisted(demo), []);
    assert.deepStrictEqual(await cursorOf(admin), [1001, 30002]);
    // The administrator has not turned on manga watchlist requests.
    assert.deepStrictEqual(await mangaRequests(), []);
  });

  it('skips titles the watchlist would refuse without looking them up', async () => {
    const admin = await findUser('admin@seerr.dev');
    await link(admin, 7001);
    await getRepository(Blocklist).save(
      new Blocklist({
        mediaType: MediaType.MANGA,
        tmdbId: 0,
        externalId: '30103',
        externalProvider: MediaIdentifierProvider.ANILIST,
        title: 'Blocklisted Manga',
      })
    );
    await createMangaMedia(dataSource.manager, 30104, MediaStatus.BLOCKLISTED);
    // The AniList ID already belongs to media of another type.
    await getRepository(Media).save(
      new Media({
        tmdbId: 0,
        mediaType: MediaType.BOOK,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
        identifiers: [
          new MediaIdentifier({
            provider: MediaIdentifierProvider.ANILIST,
            value: '30105',
            canonical: false,
          }),
        ],
      })
    );
    await Watchlist.createWatchlist({
      watchlistRequest: { mediaType: MediaType.MANGA, externalId: '30106' },
      user: admin,
    });
    catalog.set(30108, null);
    anilistCalls = [];
    lists.set(7001, [
      entry(30101, 1001, { isAdult: true }),
      entry(30102, 1002, { format: 'NOVEL' }),
      entry(30103, 1003),
      entry(30104, 1004),
      entry(30105, 1005),
      entry(30106, 1006),
      entry(30107, 1007),
      entry(30108, 1008),
    ]);

    const counts = await runMangaPlanningImport({ lastUserId: 0 });

    assert.deepStrictEqual(counts, { users: 1, added: 1, skipped: 7 });
    // AniList no longer knows 30108, which is skipped like the others.
    assert.deepStrictEqual(anilistCalls, [30107, 30108]);
    assert.deepStrictEqual(await watchlisted(admin), [30106, 30107]);
    assert.deepStrictEqual(await cursorOf(admin), [1008, 30108]);
  });

  it('requests imported manga only for users who turned on manga watchlist requests', async () => {
    const admin = await findUser('admin@seerr.dev');
    const friend = await configureUser(
      'friend@seerr.dev',
      Permission.REQUEST_MANGA + Permission.AUTO_REQUEST_MANGA,
      true
    );
    await link(admin, 7001);
    await link(friend, 7002);
    lists.set(7001, [entry(30201, 1000)]);
    lists.set(7002, [entry(30202, 1000)]);

    const counts = await runMangaPlanningImport({ lastUserId: 0 });

    assert.deepStrictEqual(counts, { users: 2, added: 2, skipped: 0 });
    assert.deepStrictEqual(await watchlisted(admin), [30201]);
    assert.deepStrictEqual(await watchlisted(friend), [30202]);
    const [request, ...others] = await mangaRequests();
    assert.deepStrictEqual(others, []);
    assert.strictEqual(request.requestedBy.id, friend.id);
    assert.strictEqual(request.status, MediaRequestStatus.PENDING);
    assert.strictEqual(request.isAutoRequest, true);
    const manifest = await getRepository(MangaRequestManifest).findOneOrFail({
      where: { requestId: request.id },
    });
    assert.strictEqual(manifest.anilistId, 30202);
    // No library holds the title yet, so the request waits for one.
    assert.strictEqual(
      manifest.bindingState,
      MangaRequestBindingState.AWAITING_BINDING
    );
    assert.deepStrictEqual(enqueued, []);
  });

  it('bounds each run and gives every user a turn', async () => {
    const admin = await findUser('admin@seerr.dev');
    const friend = await findUser('friend@seerr.dev');
    assert.ok(admin.id < friend.id);
    await link(admin, 7001);
    await link(friend, 7002);
    lists.set(7001, [entry(30301, 2000), entry(30302, 2001)]);
    // 260 entries changed one second apart: only the newest 200 are read.
    lists.set(
      7002,
      range(0, 260).map((index) => entry(100000 + index, 1000 + index))
    );
    const rotation = { lastUserId: 0 };
    const readPages = () =>
      reads.map(({ anilistUserId, page }) => [anilistUserId, page]);

    const first = await runMangaPlanningImport(rotation);

    assert.deepStrictEqual(first, { users: 2, added: 10, skipped: 0 });
    assert.deepStrictEqual(readPages(), [
      [7001, 1],
      [7002, 1],
      [7002, 2],
      [7002, 3],
      [7002, 4],
    ]);
    assert.strictEqual(
      reads.length + anilistCalls.length,
      PLANNING_IMPORT_RUN_BUDGET
    );
    assert.deepStrictEqual(await watchlisted(admin), [30301, 30302]);
    // The oldest changes in the window go first, until the budget runs out.
    assert.deepStrictEqual(await watchlisted(friend), range(100060, 8));
    assert.deepStrictEqual(await cursorOf(friend), [1067, 100067]);
    // The friend's turn was cut short, so the next run starts with them.
    assert.strictEqual(rotation.lastUserId, admin.id);

    reads = [];
    anilistCalls = [];
    const second = await runMangaPlanningImport(rotation);

    assert.deepStrictEqual(second, {
      users: 1,
      added: PLANNING_IMPORT_MAX_ADDS,
      skipped: 0,
    });
    assert.deepStrictEqual(readPages(), [
      [7002, 1],
      [7002, 2],
      [7002, 3],
      [7002, 4],
    ]);
    // Entries older than the first window are never imported.
    assert.deepStrictEqual(await watchlisted(friend), range(100060, 18));
    assert.deepStrictEqual(await cursorOf(friend), [1077, 100077]);
    assert.strictEqual(rotation.lastUserId, friend.id);
  });

  it('resumes after the last handled entry when entries changed in the same second', async () => {
    const admin = await findUser('admin@seerr.dev');
    await link(admin, 7001);
    lists.set(
      7001,
      range(30401, 12).map((anilistId) => entry(anilistId, 5000))
    );
    const rotation = { lastUserId: 0 };

    assert.deepStrictEqual(await runMangaPlanningImport(rotation), {
      users: 1,
      added: 10,
      skipped: 0,
    });
    assert.deepStrictEqual(await cursorOf(admin), [5000, 30410]);

    // A title removed from the watchlist stays removed.
    await getRepository(Watchlist).delete({
      mediaType: MediaType.MANGA,
      externalId: '30403',
    });
    assert.deepStrictEqual(await runMangaPlanningImport(rotation), {
      users: 1,
      added: 2,
      skipped: 0,
    });
    assert.deepStrictEqual(await watchlisted(admin), [
      ...range(30401, 2),
      ...range(30404, 9),
    ]);
    assert.deepStrictEqual(await cursorOf(admin), [5000, 30412]);

    reads = [];
    assert.deepStrictEqual(await runMangaPlanningImport(rotation), {
      users: 1,
      added: 0,
      skipped: 0,
    });
    assert.strictEqual(reads.length, 1);
  });

  it('reads each account again when its turn begins', async () => {
    const admin = await findUser('admin@seerr.dev');
    const friend = await findUser('friend@seerr.dev');
    const demo = await findUser('demo@seerr.dev');
    assert.ok(admin.id < friend.id && friend.id < demo.id);
    await link(admin, 7001);
    await link(friend, 7002);
    await link(demo, 7003);
    lists.set(7001, [entry(31401, 1000)]);
    lists.set(7002, [entry(31402, 1000)]);
    lists.set(7003, [entry(31403, 1000)]);
    lists.set(7013, [entry(31413, 1000)]);
    const relinked = randomUUID();
    // While the run reads the first list, one user turns the import off and
    // another reconnects another AniList account and turns it on again.
    onRead = async () => {
      if (reads.length > 1) return;
      await getRepository(DiscoveryAccount).update(
        { userId: friend.id, provider: 'anilist' },
        { importMangaPlanning: false }
      );
      tokens.set(demo.id, relinked);
      await saveDiscoveryAccount(
        demo.id,
        'anilist',
        { accessToken: relinked },
        { username: 'relinked', providerUserId: '7013' }
      );
      await getRepository(DiscoveryAccount).update(
        { userId: demo.id, provider: 'anilist' },
        { importMangaPlanning: true }
      );
    };

    assert.deepStrictEqual(await runMangaPlanningImport({ lastUserId: 0 }), {
      users: 2,
      added: 2,
      skipped: 0,
    });
    assert.deepStrictEqual(reads, [
      { anilistUserId: 7001, page: 1, token: tokens.get(admin.id) },
      { anilistUserId: 7013, page: 1, token: relinked },
    ]);
    assert.deepStrictEqual(await watchlisted(friend), []);
    assert.deepStrictEqual(await watchlisted(demo), [31413]);
    assert.deepStrictEqual(await cursorOf(demo), [1000, 31413]);
  });

  it('keeps no cursor for an AniList account replaced during the turn', async () => {
    const admin = await findUser('admin@seerr.dev');
    await link(admin, 7001);
    lists.set(7001, [entry(31501, 1000)]);
    onRead = async () => {
      await saveDiscoveryAccount(
        admin.id,
        'anilist',
        { accessToken: tokens.get(admin.id)! },
        { username: 'relinked', providerUserId: '7011' }
      );
      await getRepository(DiscoveryAccount).update(
        { userId: admin.id, provider: 'anilist' },
        { importMangaPlanning: true }
      );
    };

    assert.deepStrictEqual(await runMangaPlanningImport({ lastUserId: 0 }), {
      users: 1,
      added: 1,
      skipped: 0,
    });
    assert.deepStrictEqual(await watchlisted(admin), [31501]);
    // The entry came from the earlier account's list.
    assert.deepStrictEqual(await cursorOf(admin), [null, null]);
  });

  it('leaves removed items and requests alone and imports an entry again once it changes', async () => {
    const admin = await configureUser(
      'admin@seerr.dev',
      Permission.ADMIN,
      true
    );
    await link(admin, 7001);
    lists.set(7001, [entry(30501, 3000), entry(30502, 3001)]);
    const rotation = { lastUserId: 0 };
    const requestStates = async () =>
      (await mangaRequests()).map(({ id, status }) => [id, status]);
    await runMangaPlanningImport(rotation);
    const requested = await requestStates();
    assert.strictEqual(requested.length, 2);

    // One title is removed from the watchlist, the other from AniList.
    await getRepository(Watchlist).delete({
      mediaType: MediaType.MANGA,
      externalId: '30501',
    });
    lists.set(7001, [entry(30501, 3000)]);
    await runMangaPlanningImport(rotation);

    assert.deepStrictEqual(await watchlisted(admin), [30502]);
    assert.deepStrictEqual(await requestStates(), requested);

    lists.set(7001, [entry(30501, 3100)]);
    assert.deepStrictEqual(await runMangaPlanningImport(rotation), {
      users: 1,
      added: 1,
      skipped: 0,
    });
    assert.deepStrictEqual(await watchlisted(admin), [30502, 30501]);
    assert.deepStrictEqual(await requestStates(), requested);
    assert.deepStrictEqual(await cursorOf(admin), [3100, 30501]);
  });

  it('stops without moving on while AniList is rate limited', async () => {
    const admin = await findUser('admin@seerr.dev');
    const friend = await findUser('friend@seerr.dev');
    await link(admin, 7001);
    await link(friend, 7002);
    lists.set(7001, new AnilistRateLimitedError(30));
    lists.set(7002, [entry(30601, 1000)]);
    const rotation = { lastUserId: 0 };

    assert.deepStrictEqual(await runMangaPlanningImport(rotation), {
      users: 0,
      added: 0,
      skipped: 0,
    });
    assert.deepStrictEqual(
      reads.map(({ anilistUserId }) => anilistUserId),
      [7001]
    );
    assert.strictEqual(rotation.lastUserId, 0);
    assert.deepStrictEqual(await watchlisted(friend), []);
    assert.deepStrictEqual(
      logged('AniList is unavailable; the import continues next run'),
      [['info', { label: LABEL, errorName: 'AnilistRateLimitedError' }]]
    );
  });

  it('keeps the progress made before an AniList outage', async () => {
    const admin = await findUser('admin@seerr.dev');
    const friend = await findUser('friend@seerr.dev');
    await link(admin, 7001);
    await link(friend, 7002);
    lists.set(7001, [
      entry(30701, 1000),
      entry(30702, 1001),
      entry(30703, 1002),
    ]);
    lists.set(7002, [entry(30704, 1000)]);
    catalog.set(30702, new AnilistOutageError());
    const rotation = { lastUserId: 0 };

    assert.deepStrictEqual(await runMangaPlanningImport(rotation), {
      users: 1,
      added: 1,
      skipped: 0,
    });
    assert.deepStrictEqual(await watchlisted(admin), [30701]);
    assert.deepStrictEqual(await cursorOf(admin), [1000, 30701]);
    assert.strictEqual(rotation.lastUserId, 0);
    assert.deepStrictEqual(await watchlisted(friend), []);
    assert.deepStrictEqual(
      logged('AniList is unavailable; the import continues next run'),
      [['info', { label: LABEL, errorName: 'AnilistOutageError' }]]
    );

    catalog.delete(30702);
    assert.deepStrictEqual(await runMangaPlanningImport(rotation), {
      users: 2,
      added: 3,
      skipped: 0,
    });
    assert.deepStrictEqual(await watchlisted(admin), [30701, 30702, 30703]);
    assert.deepStrictEqual(await watchlisted(friend), [30704]);
    assert.strictEqual(rotation.lastUserId, friend.id);
  });

  it('goes on to the next user when one title cannot be added', async () => {
    const admin = await findUser('admin@seerr.dev');
    const friend = await findUser('friend@seerr.dev');
    await link(admin, 7001);
    await link(friend, 7002);
    lists.set(7001, [entry(30801, 1000), entry(30802, 1001)]);
    lists.set(7002, [entry(30803, 1000)]);
    catalog.set(30801, new Error('Unexpected reply'));
    const rotation = { lastUserId: 0 };

    assert.deepStrictEqual(await runMangaPlanningImport(rotation), {
      users: 2,
      added: 1,
      skipped: 0,
    });
    assert.deepStrictEqual(await watchlisted(admin), []);
    assert.deepStrictEqual(await cursorOf(admin), [null, null]);
    assert.deepStrictEqual(await watchlisted(friend), [30803]);
    assert.strictEqual(rotation.lastUserId, friend.id);
    assert.deepStrictEqual(
      logged('Could not add a Planning manga to a watchlist'),
      [
        [
          'warn',
          {
            label: LABEL,
            userId: admin.id,
            anilistId: 30801,
            errorName: 'Error',
            errorMessage: 'Unexpected reply',
          },
        ],
      ]
    );

    // The title is tried again on the user's next turn.
    catalog.delete(30801);
    await runMangaPlanningImport(rotation);
    assert.deepStrictEqual(await watchlisted(admin), [30801, 30802]);
    assert.deepStrictEqual(await cursorOf(admin), [1001, 30802]);
  });

  it('skips users whose AniList link cannot be used', async () => {
    const admin = await findUser('admin@seerr.dev');
    const friend = await findUser('friend@seerr.dev');
    const demo = await findUser('demo@seerr.dev');
    const reader = await createUser('reader@seerr.dev', Permission.REQUEST);
    await link(admin, 7001, { expiresAt: 1 });
    await link(friend, 7002, { clientId: 'another-app' });
    await link(demo, 7003);
    await link(reader, 7004);
    lists.set(7001, [entry(30901, 1000)]);
    lists.set(7002, [entry(30902, 1000)]);
    lists.set(7003, new AnilistAuthError());
    lists.set(7004, [entry(30904, 1000)]);
    const rotation = { lastUserId: 0 };

    assert.deepStrictEqual(await runMangaPlanningImport(rotation), {
      users: 1,
      added: 1,
      skipped: 0,
    });
    assert.deepStrictEqual(
      reads.map(({ anilistUserId }) => anilistUserId),
      [7003, 7004]
    );
    assert.deepStrictEqual(await watchlisted(reader), [30904]);
    assert.strictEqual(rotation.lastUserId, reader.id);
    assert.deepStrictEqual(
      logged('Skipping a user whose AniList link is unusable').map(
        ([level, meta]) => [level, meta.userId]
      ),
      [
        ['debug', admin.id],
        ['debug', friend.id],
        ['debug', demo.id],
      ]
    );
  });

  it('looks the AniList user up when the link has no user ID', async () => {
    const admin = await findUser('admin@seerr.dev');
    await link(admin, null);
    viewer = { id: 7100, name: 'reader' };
    lists.set(7100, [entry(31001, 1000)]);

    assert.deepStrictEqual(await runMangaPlanningImport({ lastUserId: 0 }), {
      users: 1,
      added: 1,
      skipped: 0,
    });
    assert.deepStrictEqual(viewerCalls, [tokens.get(admin.id)]);
    assert.deepStrictEqual(reads, [
      { anilistUserId: 7100, page: 1, token: tokens.get(admin.id) },
    ]);
  });

  it('does nothing while the manga category is disabled', async () => {
    const admin = await findUser('admin@seerr.dev');
    await link(admin, 7001);
    lists.set(7001, [entry(31101, 1000)]);
    setMangaEnabled(false);

    assert.deepStrictEqual(await runMangaPlanningImport({ lastUserId: 0 }), {
      users: 0,
      added: 0,
      skipped: 0,
    });
    await mangaPlanningImporter.run();
    assert.deepStrictEqual(reads, []);

    // Turned off during a run, the category stops it before any add.
    setMangaEnabled(true);
    onRead = async () => setMangaEnabled(false);
    const rotation = { lastUserId: 0 };
    await runMangaPlanningImport(rotation);
    assert.deepStrictEqual(await watchlisted(admin), []);
    assert.deepStrictEqual(await cursorOf(admin), [null, null]);
    assert.strictEqual(rotation.lastUserId, 0);
  });

  it('runs one import at a time and stops when cancelled', async () => {
    const admin = await findUser('admin@seerr.dev');
    await link(admin, 7001);
    lists.set(7001, [entry(31201, 1000)]);
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    onRead = (signal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new CanceledError()), {
          once: true,
        });
        started();
      });

    const run = mangaPlanningImporter.run();
    await reading;
    assert.deepStrictEqual(mangaPlanningImporter.status(), { running: true });
    await mangaPlanningImporter.run();
    assert.strictEqual(reads.length, 1);
    mangaPlanningImporter.cancel();
    await run;

    assert.deepStrictEqual(mangaPlanningImporter.status(), { running: false });
    assert.deepStrictEqual(await watchlisted(admin), []);
    assert.deepStrictEqual(logged('AniList Planning import cancelled'), [
      ['info', { label: LABEL }],
    ]);
    assert.deepStrictEqual(logged('AniList Planning import failed'), []);
  });

  it('never logs the AniList token of a failed list read', async () => {
    const admin = await findUser('admin@seerr.dev');
    const friend = await findUser('friend@seerr.dev');
    await link(admin, 7001);
    await link(friend, 7002);
    // The real client builds the requests, so a failure carries its headers.
    pages.mock.restore();
    const queries: string[] = [];
    anilistPost = async (_endpoint, data, config) => {
      queries.push(String(data?.query ?? ''));
      const authorization = String(
        (config?.headers as Record<string, unknown> | undefined)
          ?.Authorization ?? ''
      );
      if (authorization.endsWith(tokens.get(friend.id) ?? '-')) {
        return {
          data: {
            Page: {
              pageInfo: { hasNextPage: false },
              mediaList: [
                {
                  updatedAt: 1000,
                  media: { id: 31301, format: 'MANGA', isAdult: false },
                },
              ],
            },
          },
        };
      }
      const failed = {
        method: 'post',
        url: '',
        headers: AxiosHeaders.from({ Authorization: authorization }),
      } as InternalAxiosRequestConfig;
      throw new AxiosError(
        'Request failed with status code 500',
        AxiosError.ERR_BAD_RESPONSE,
        failed,
        undefined,
        {
          status: 500,
          statusText: 'Internal Server Error',
          headers: {},
          config: failed,
          data: { errors: [{ message: 'Internal Server Error', status: 500 }] },
        }
      );
    };

    const counts = await runMangaPlanningImport({ lastUserId: 0 });

    assert.deepStrictEqual(counts, { users: 1, added: 1, skipped: 0 });
    assert.deepStrictEqual(await watchlisted(friend), [31301]);
    // Both list reads are queries: the import sends AniList no mutation.
    assert.strictEqual(queries.length, 2);
    for (const query of queries) {
      assert.match(query, /^\s*query MangaPlanningPage\(/);
      assert.doesNotMatch(query, /mutation/i);
    }
    const [failure, ...others] = logged('Could not read a Planning list');
    assert.deepStrictEqual(others, []);
    assert.strictEqual(failure[0], 'warn');
    assert.strictEqual(failure[1].userId, admin.id);
    assert.strictEqual(failure[1].errorName, 'AxiosError');
    assert.strictEqual(failure[1].status, 500);
    const logText = inspect(logs, { depth: null });
    assert.strictEqual(logText.includes(tokens.get(admin.id)!), false);
    assert.strictEqual(JSON.stringify(counts).includes('Bearer'), false);
  });
});

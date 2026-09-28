import JellyfinAPI from '@server/api/jellyfin';
import PlexAPI from '@server/api/plexapi';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { personalMediaServerLibrary } from './mediaServerLibrary';

setupTestDb();

const settings = getSettings();
const originalSections = {
  main: structuredClone(settings.main),
  plex: structuredClone(settings.plex),
  jellyfin: structuredClone(settings.jellyfin),
};
let originalUser:
  | Pick<
      User,
      | 'id'
      | 'plexToken'
      | 'jellyfinUserId'
      | 'jellyfinDeviceId'
      | 'jellyfinAuthToken'
    >
  | undefined;

afterEach(async () => {
  mock.restoreAll();
  settings.replaceSection('main', structuredClone(originalSections.main));
  settings.replaceSection('plex', structuredClone(originalSections.plex));
  settings.replaceSection(
    'jellyfin',
    structuredClone(originalSections.jellyfin)
  );
  cacheManager.getCache('personallibrary').flush();
  if (originalUser) {
    await getRepository(User).update(originalUser.id, {
      plexToken: originalUser.plexToken,
      jellyfinUserId: originalUser.jellyfinUserId,
      jellyfinDeviceId: originalUser.jellyfinDeviceId,
      jellyfinAuthToken: originalUser.jellyfinAuthToken,
    });
  }
});

async function testUser() {
  const user = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });
  originalUser = {
    id: user.id,
    plexToken: user.plexToken,
    jellyfinUserId: user.jellyfinUserId,
    jellyfinDeviceId: user.jellyfinDeviceId,
    jellyfinAuthToken: user.jellyfinAuthToken,
  };
  return user;
}

it('limits Plex personal pages to enabled, user-visible libraries and keeps watch state', async () => {
  const user = await testUser();
  await getRepository(User).update(user.id, { plexToken: 'linked-plex-token' });
  settings.replaceSection('main', {
    ...settings.main,
    mediaServerType: MediaServerType.PLEX,
  });
  settings.replaceSection('plex', {
    ...settings.plex,
    ip: '127.0.0.1',
    libraries: [
      { id: '1', name: 'Enabled films', enabled: true, type: 'movie' },
      { id: '2', name: 'Disabled films', enabled: false, type: 'movie' },
    ],
  });
  mock.method(PlexAPI.prototype, 'getLibraries', async () => [
    { key: '1', title: 'Enabled films', type: 'movie', agent: 'plex' },
    { key: '2', title: 'Disabled films', type: 'movie', agent: 'plex' },
  ]);
  let requestedOffset = -1;
  mock.method(
    PlexAPI.prototype,
    'getLibraryContents',
    async (
      _id: string,
      options?: {
        offset?: number;
        size?: number;
        libraryType?: 'show' | 'movie' | 'music' | 'book';
      }
    ) => {
      requestedOffset = options?.offset ?? -1;
      return {
        totalSize: 25,
        items: [
          {
            ratingKey: 'movie-1',
            title: 'Watched film',
            guid: 'plex://movie/movie-1',
            Guid: [{ id: 'tmdb://42' }],
            addedAt: 0,
            updatedAt: 0,
            year: 2025,
            type: 'movie',
            viewCount: 1,
            Media: [],
          },
        ],
      };
    }
  );

  const page = await personalMediaServerLibrary(
    user.id,
    'plex',
    'watched',
    2,
    '1'
  );

  assert.deepStrictEqual(page.libraries, [
    { id: '1', name: 'Enabled films', type: 'movie' },
  ]);
  assert.strictEqual(requestedOffset, 20);
  assert.strictEqual(page.items[0].status, 'completed');
  assert.strictEqual(page.items[0].tmdbId, 42);
  assert.strictEqual(page.items[0].sourceId, 'movie-1');
  assert.strictEqual(page.allowWrites, false);
});

it('fills sparse Plex in-progress pages without leaving the match on the next raw page', async () => {
  const user = await testUser();
  await getRepository(User).update(user.id, { plexToken: 'linked-plex-token' });
  settings.replaceSection('main', {
    ...settings.main,
    mediaServerType: MediaServerType.PLEX,
  });
  settings.replaceSection('plex', {
    ...settings.plex,
    ip: '127.0.0.1',
    libraries: [{ id: 'shows', name: 'Series', enabled: true, type: 'show' }],
  });
  mock.method(PlexAPI.prototype, 'getLibraries', async () => [
    { key: 'shows', title: 'Series', type: 'show', agent: 'plex' },
  ]);
  let requestedSize = 0;
  mock.method(
    PlexAPI.prototype,
    'getLibraryContents',
    async (
      _id: string,
      options?: {
        offset?: number;
        size?: number;
        libraryType?: 'show' | 'movie' | 'music' | 'book';
        isWatched?: boolean;
      }
    ) => {
      requestedSize = options?.size ?? 0;
      return {
        totalSize: 25,
        items: Array.from({ length: 25 }, (_, index) => ({
          ratingKey: `show-${index}`,
          title: `Series ${index}`,
          guid: `plex://show/${index}`,
          Guid: [{ id: `tmdb://${index + 1}` }],
          addedAt: 0,
          updatedAt: 0,
          type: 'show' as const,
          leafCount: 10,
          viewedLeafCount: index === 22 ? 3 : 0,
          Media: [],
        })),
      };
    }
  );

  const page = await personalMediaServerLibrary(
    user.id,
    'plex',
    'in-progress',
    1,
    'shows'
  );

  assert.strictEqual(requestedSize, 100);
  assert.deepStrictEqual(
    page.items.map((item) => [item.title, item.status, item.progress]),
    [['Series 22', 'watching', 3]]
  );
  assert.strictEqual(page.hasMore, false);
});

it('continues sparse movie progress pages from the returned native cursor', async () => {
  const user = await testUser();
  await getRepository(User).update(user.id, { plexToken: 'linked-plex-token' });
  settings.replaceSection('main', {
    ...settings.main,
    mediaServerType: MediaServerType.PLEX,
  });
  settings.replaceSection('plex', {
    ...settings.plex,
    ip: '127.0.0.1',
    libraries: [{ id: 'movies', name: 'Films', enabled: true, type: 'movie' }],
  });
  mock.method(PlexAPI.prototype, 'getLibraries', async () => [
    { key: 'movies', title: 'Films', type: 'movie', agent: 'plex' },
  ]);
  const requestedOffsets: number[] = [];
  mock.method(
    PlexAPI.prototype,
    'getLibraryContents',
    async (
      _id: string,
      options?: {
        offset?: number;
        size?: number;
        libraryType?: 'show' | 'movie' | 'music' | 'book';
      }
    ) => {
      const offset = options?.offset ?? 0;
      requestedOffsets.push(offset);
      const size = options?.size ?? 20;
      return {
        totalSize: 120,
        items: Array.from({ length: Math.min(size, 120 - offset) }, (_, i) => {
          const index = offset + i;
          return {
            ratingKey: `movie-${index}`,
            title: `Movie ${index}`,
            guid: `plex://movie/${index}`,
            addedAt: 0,
            updatedAt: 0,
            type: 'movie' as const,
            viewCount: 0,
            viewOffset: index < 25 ? 60_000 : 0,
            Media: [],
          };
        }),
      };
    }
  );

  const firstPage = await personalMediaServerLibrary(
    user.id,
    'plex',
    'in-progress',
    1,
    'movies'
  );
  const secondPage = await personalMediaServerLibrary(
    user.id,
    'plex',
    'in-progress',
    2,
    'movies',
    firstPage.nextCursor
  );

  assert.strictEqual(firstPage.items.length, 20);
  assert.strictEqual(firstPage.items[0].status, 'watching');
  assert.strictEqual(firstPage.items[19].title, 'Movie 19');
  assert.strictEqual(firstPage.hasMore, true);
  assert.strictEqual(firstPage.nextCursor, 20);
  assert.deepStrictEqual(
    secondPage.items.map((item) => item.title),
    ['Movie 20', 'Movie 21', 'Movie 22', 'Movie 23', 'Movie 24']
  );
  assert.strictEqual(secondPage.hasMore, false);
  assert.deepStrictEqual(requestedOffsets, [0, 20]);
});

it('reports the hard native cursor limit without offering an empty next page', async () => {
  const user = await testUser();
  await getRepository(User).update(user.id, { plexToken: 'linked-plex-token' });
  settings.replaceSection('main', {
    ...settings.main,
    mediaServerType: MediaServerType.PLEX,
  });
  settings.replaceSection('plex', {
    ...settings.plex,
    ip: '127.0.0.1',
    libraries: [{ id: 'movies', name: 'Films', enabled: true, type: 'movie' }],
  });
  mock.method(PlexAPI.prototype, 'getLibraries', async () => [
    { key: 'movies', title: 'Films', type: 'movie', agent: 'plex' },
  ]);
  let requestedOffset = -1;
  mock.method(
    PlexAPI.prototype,
    'getLibraryContents',
    async (
      _id: string,
      options?: {
        offset?: number;
        size?: number;
        libraryType?: 'show' | 'movie' | 'music' | 'book';
      }
    ) => {
      requestedOffset = options?.offset ?? -1;
      return {
        totalSize: 100_001,
        items: Array.from({ length: options?.size ?? 0 }, (_, index) => ({
          ratingKey: `movie-${requestedOffset + index}`,
          title: `Movie ${requestedOffset + index}`,
          guid: `plex://movie/${requestedOffset + index}`,
          addedAt: 0,
          updatedAt: 0,
          type: 'movie' as const,
          viewCount: 0,
          viewOffset: 0,
          Media: [],
        })),
      };
    }
  );

  const page = await personalMediaServerLibrary(
    user.id,
    'plex',
    'in-progress',
    2,
    'movies',
    99_900
  );

  assert.strictEqual(requestedOffset, 99_900);
  assert.strictEqual(page.nextCursor, 100_000);
  assert.strictEqual(page.hasMore, false);
  assert.strictEqual(page.truncated, true);
});

it('does not use an administrator Plex credential when the user has no linked token', async () => {
  const user = await testUser();
  await getRepository(User).update(user.id, { plexToken: null });
  settings.replaceSection('main', {
    ...settings.main,
    mediaServerType: MediaServerType.PLEX,
  });
  settings.replaceSection('plex', {
    ...settings.plex,
    ip: '127.0.0.1',
    libraries: [{ id: '1', name: 'Films', enabled: true, type: 'movie' }],
  });
  const libraryRead = mock.method(PlexAPI.prototype, 'getLibraries');

  await assert.rejects(
    personalMediaServerLibrary(user.id, 'plex', 'all', 1),
    (error: { status?: number }) => error.status === 409
  );
  assert.strictEqual(libraryRead.mock.callCount(), 0);
});

it('reads Jellyfin user views and watched data with the linked user identity', async () => {
  const user = await testUser();
  const jellyfinUserId = 'a2ed2f1f-5a82-4c55-9a1c-1385e4e90ca1';
  await getRepository(User).update(user.id, {
    jellyfinUserId,
    jellyfinAuthToken: 'linked-jellyfin-token',
  });
  settings.replaceSection('main', {
    ...settings.main,
    mediaServerType: MediaServerType.JELLYFIN,
  });
  settings.replaceSection('jellyfin', {
    ...settings.jellyfin,
    ip: '127.0.0.1',
    libraries: [
      { id: 'movies-id', name: 'Movies', enabled: true, type: 'movie' },
      { id: 'hidden-id', name: 'Hidden', enabled: true, type: 'movie' },
    ],
  });
  mock.method(JellyfinAPI.prototype, 'getUserLibraries', async () => [
    { key: 'movies-id', title: 'Movies', type: 'movie', agent: 'jellyfin' },
  ]);
  let queriedUserData = false;
  mock.method(
    JellyfinAPI.prototype,
    'getUserLibraryContents',
    async (
      _id: string,
      _type: 'show' | 'movie',
      options?: { offset?: number; size?: number; isPlayed?: boolean }
    ) => {
      queriedUserData = options?.isPlayed === true;
      return {
        Items: [
          {
            Id: 'movie-2',
            Name: 'Watched Jellyfin film',
            Type: 'Movie',
            HasSubtitles: false,
            LocationType: 'FileSystem',
            MediaType: 'Video',
            ProviderIds: {
              Tmdb: '84',
              TheMovieDb: undefined,
              Imdb: undefined,
              Tvdb: undefined,
              AniDB: undefined,
              MusicBrainzAlbum: undefined,
              MusicBrainzReleaseGroup: undefined,
              MusicBrainzArtist: undefined,
            },
            ProductionYear: 2024,
            UserData: { Played: true },
          },
        ],
        TotalRecordCount: 1,
        StartIndex: 0,
      };
    }
  );

  const page = await personalMediaServerLibrary(
    user.id,
    'jellyfin',
    'watched',
    1,
    'movies-id'
  );

  assert.deepStrictEqual(page.libraries, [
    { id: 'movies-id', name: 'Movies', type: 'movie' },
  ]);
  assert.strictEqual(queriedUserData, true);
  assert.strictEqual(page.items[0].status, 'completed');
  assert.strictEqual(page.items[0].tmdbId, 84);
  assert.strictEqual(page.items[0].year, 2024);
});

it('scans past unplayed Jellyfin items to fill the personal in-progress shelf', async () => {
  const user = await testUser();
  const jellyfinUserId = 'a2ed2f1f-5a82-4c55-9a1c-1385e4e90ca1';
  await getRepository(User).update(user.id, {
    jellyfinUserId,
    jellyfinAuthToken: 'linked-jellyfin-token',
  });
  settings.replaceSection('main', {
    ...settings.main,
    mediaServerType: MediaServerType.JELLYFIN,
  });
  settings.replaceSection('jellyfin', {
    ...settings.jellyfin,
    ip: '127.0.0.1',
    libraries: [
      { id: 'movies-id', name: 'Movies', enabled: true, type: 'movie' },
    ],
  });
  mock.method(JellyfinAPI.prototype, 'getUserLibraries', async () => [
    { key: 'movies-id', title: 'Movies', type: 'movie', agent: 'jellyfin' },
  ]);
  let requestedSize = 0;
  mock.method(
    JellyfinAPI.prototype,
    'getUserLibraryContents',
    async (
      _id: string,
      _type: 'show' | 'movie',
      options?: { offset?: number; size?: number; isPlayed?: boolean }
    ) => {
      requestedSize = options?.size ?? 0;
      return {
        Items: Array.from({ length: 25 }, (_, index) => ({
          Id: `movie-${index}`,
          Name: `Movie ${index}`,
          Type: 'Movie' as const,
          HasSubtitles: false,
          LocationType: 'FileSystem',
          MediaType: 'Video',
          ProviderIds: {
            Tmdb: String(index + 1),
            TheMovieDb: undefined,
            Imdb: undefined,
            Tvdb: undefined,
            AniDB: undefined,
            MusicBrainzAlbum: undefined,
            MusicBrainzReleaseGroup: undefined,
            MusicBrainzArtist: undefined,
          },
          UserData: {
            Played: false,
            PlaybackPositionTicks: index === 22 ? 30_000_000 : 0,
          },
        })),
        TotalRecordCount: 25,
        StartIndex: options?.offset ?? 0,
      };
    }
  );

  const page = await personalMediaServerLibrary(
    user.id,
    'jellyfin',
    'in-progress',
    1,
    'movies-id'
  );

  assert.strictEqual(requestedSize, 100);
  assert.deepStrictEqual(
    page.items.map((item) => [item.title, item.status]),
    [['Movie 22', 'watching']]
  );
  assert.strictEqual(page.hasMore, false);
});

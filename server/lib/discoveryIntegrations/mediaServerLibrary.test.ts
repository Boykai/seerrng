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

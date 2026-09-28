import AnilistAPI from '@server/api/anilist';
import SimklAPI from '@server/api/simkl';
import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import DiscoveryAccount from '@server/entity/DiscoveryAccount';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { savePersonalIdentityMapping } from './identityMappings';
import { personalProviderLibrary } from './library';
setupTestDb();
afterEach(() => mock.restoreAll());
let sequence = 0;
async function connect(provider: 'trakt' | 'anilist' | 'simkl') {
  const user = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });
  const credential = `${provider}-library-test-${++sequence}`;
  const config = getSettings().discoveryIntegrations[provider];
  config.clientId = 'library-test-application';
  await getRepository(DiscoveryAccount).save({
    userId: user.id,
    provider,
    clientId: config.clientId,
    accessToken: credential,
    providerUserId: 'library-test-user',
    username: 'Library Test',
    allowWrites: false,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  return user.id;
}
it('reads the requested Trakt page and preserves incomplete series progress', async () => {
  const userId = await connect('trakt');
  mock.method(TraktAPI.prototype, 'prepareAccessToken', async () => undefined);
  const read = mock.method(
    TraktAPI.prototype,
    'getSyncLibraryPage',
    async () => [
      {
        show: {
          title: 'Partial season',
          year: 2025,
          ids: { trakt: 8, tmdb: 80 },
        },
        seasons: [
          {
            number: 1,
            episodes: [
              { number: 1, plays: 1 },
              { number: 2, plays: 0 },
            ],
          },
        ],
      },
    ]
  );
  const result = await personalProviderLibrary(
    userId,
    'trakt',
    'watched',
    2,
    'tv'
  );
  assert.equal(read.mock.calls[0].arguments[0], 'tv');
  assert.equal(read.mock.calls[0].arguments[2], 2);
  assert.equal(result.items[0].status, 'watched');
  assert.equal(result.items[0].progress, 1);
  assert.equal(result.items[0].tmdbId, 80);
});
it('keeps native AniList identity, maps shelves, and paginates the filtered library', async () => {
  const userId = await connect('anilist');
  mock.method(AnilistAPI.prototype, 'getViewer', async () => ({
    id: 42,
    name: 'Library Test',
  }));
  mock.method(AnilistAPI.prototype, 'getMediaListCollection', async () => ({
    lists: [
      {
        entries: [
          {
            status: 'COMPLETED',
            score: 8.5,
            progress: 12,
            media: {
              id: 101,
              format: 'TV',
              episodes: 12,
              seasonYear: 2024,
              title: { english: 'Native anime' },
              coverImage: {
                large: 'https://s4.anilist.co/file/cover.jpg',
              },
            },
          },
          {
            status: 'PLANNING',
            progress: 0,
            media: {
              id: 102,
              format: 'MOVIE',
              title: { romaji: 'Planned film' },
            },
          },
        ],
      },
    ],
  }));
  const result = await personalProviderLibrary(
    userId,
    'anilist',
    'completed',
    1
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, 'anilist:101');
  assert.equal(result.items[0].tmdbId, undefined);
  assert.equal(result.items[0].rating, 8.5);
  assert.equal(
    result.items[0].imageUrl,
    'https://s4.anilist.co/file/cover.jpg'
  );
  assert.equal(result.items[0].status, 'completed');
});
it('does not infer TMDB identity or media type for Simkl anime entries', async () => {
  const userId = await connect('simkl');
  mock.method(SimklAPI.prototype, 'getAllItems', async () => ({
    anime: [
      {
        show: {
          title: 'Unmapped anime',
          year: 2024,
          ids: { simkl: 77, tmdb: 777 },
        },
        status: 'watching',
        watched_episodes_count: 3,
        total_episodes_count: 12,
      },
    ],
  }));
  const result = await personalProviderLibrary(
    userId,
    'simkl',
    'in-progress',
    1
  );
  assert.equal(result.items[0].id, 'simkl:anime:77');
  assert.equal(result.items[0].mediaType, undefined);
  assert.equal(result.items[0].tmdbId, undefined);
  assert.equal(result.items[0].progress, 3);
  assert.equal(result.missingMappings, 1);

  await savePersonalIdentityMapping(userId, 'simkl:anime:77', 888, 'tv');
  const repaired = await personalProviderLibrary(
    userId,
    'simkl',
    'in-progress',
    1,
    'tv'
  );
  assert.equal(repaired.items.length, 1);
  assert.equal(repaired.items[0].tmdbId, 888);
  assert.equal(repaired.items[0].mediaType, 'tv');
  assert.equal(repaired.items[0].identityMapped, true);
  assert.equal(repaired.missingMappings, 0);
});
it('rejects unsupported pages before looking up a provider account', async () => {
  await assert.rejects(
    () => personalProviderLibrary(999999, 'trakt', 'watched', 501),
    /valid library shelf and page/
  );
});

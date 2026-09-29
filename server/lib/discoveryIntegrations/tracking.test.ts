import AnilistAPI from '@server/api/anilist';
import ExternalAPI from '@server/api/externalapi';
import SimklAPI from '@server/api/simkl';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import DiscoveryAccount from '@server/entity/DiscoveryAccount';
import ProviderTrackingAction from '@server/entity/ProviderTrackingAction';
import { User } from '@server/entity/User';
import { getSettings, MetadataProviderType } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import {
  applyTrackingIntent,
  parseTrackingIntent,
  prepareTrackingAccount,
} from './tracking';
setupTestDb();
afterEach(() => mock.restoreAll());
const requestId = '00000000-0000-4000-8000-000000000001';
const externalApiPrototype = ExternalAPI.prototype as unknown as {
  get: (endpoint: string, ...args: unknown[]) => Promise<unknown>;
};

function tmdbShow(isAnime: boolean) {
  return {
    id: 42,
    external_ids: { tvdb_id: 1399 },
    keywords: {
      results: isAnime ? [{ id: ANIME_KEYWORD_ID, name: 'Anime' }] : [],
    },
    videos: {
      results: [
        { id: 'trailer', key: 'trailer', site: 'YouTube', type: 'Trailer' },
      ],
    },
  };
}

async function account(
  provider: 'trakt' | 'simkl' | 'anilist',
  allowWrites = true
) {
  const user = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });
  const config = getSettings().discoveryIntegrations[provider];
  config.clientId = 'application';
  await getRepository(DiscoveryAccount).save({
    userId: user.id,
    provider,
    clientId: 'application',
    accessToken: 'credential',
    providerUserId: 'person',
    username: 'Person',
    allowWrites,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  return user.id;
}
it('validates native identities and action-specific values without trusting coercion', () => {
  const valid = {
    requestId,
    action: 'watched',
    value: true,
    mediaType: 'movie',
    tmdbId: 2,
  };
  assert.equal(parseTrackingIntent('trakt', valid).tmdbId, 2);
  for (const body of [
    { ...valid, value: 'true' },
    { ...valid, action: {} },
    { ...valid, tmdbId: '2' },
    { ...valid, episode: { season: 1, episode: 1 } },
    { ...valid, accessToken: 'browser-token' },
    { ...valid, requestId: 'invalid' },
    { ...valid, action: 'rating', value: 11 },
    { ...valid, action: 'rating', value: 7.5 },
  ])
    assert.throws(() => parseTrackingIntent('trakt', body));
  const first = parseTrackingIntent('trakt', valid);
  const reordered = parseTrackingIntent('trakt', {
    tmdbId: 2,
    mediaType: 'movie',
    value: true,
    action: 'watched',
    requestId,
  });
  assert.equal(JSON.stringify(first), JSON.stringify(reordered));
});
it('requires current explicit write consent before preparing or applying a mutation', async () => {
  const userId = await account('trakt', false);
  await assert.rejects(() => prepareTrackingAccount(userId, 'trakt'), /Enable/);
  await assert.rejects(
    () =>
      applyTrackingIntent(
        userId,
        'trakt',
        parseTrackingIntent('trakt', {
          requestId,
          action: 'rating',
          value: 8,
          mediaType: 'movie',
          tmdbId: 2,
        }),
        'credential'
      ),
    /consent changed/
  );
  assert.equal(await getRepository(ProviderTrackingAction).count(), 0);
});
it('stores intent before a write and prevents repeating an acknowledged request', async () => {
  const userId = await account('trakt');
  const intent = parseTrackingIntent('trakt', {
    requestId,
    action: 'rating',
    value: 8,
    mediaType: 'movie',
    tmdbId: 2,
  });
  const write = mock.method(TraktAPI.prototype, 'addRating', async () => {
    assert.equal(
      (
        await getRepository(ProviderTrackingAction).findOneByOrFail({
          userId,
          requestId,
        })
      ).state,
      'pending'
    );
    return { added: { movies: 1 }, not_found: { movies: [] } };
  });
  assert.equal(
    (await applyTrackingIntent(userId, 'trakt', intent, 'credential')).state,
    'succeeded'
  );
  assert.equal(
    (await applyTrackingIntent(userId, 'trakt', intent, 'credential')).state,
    'succeeded'
  );
  assert.equal(write.mock.callCount(), 1);
  await assert.rejects(
    () =>
      applyTrackingIntent(
        userId,
        'trakt',
        { ...intent, value: 9 },
        'credential'
      ),
    /another operation/
  );
});
it('retains unknown outcomes and refuses an automatic repeat after a timeout', async () => {
  const userId = await account('trakt');
  const intent = parseTrackingIntent('trakt', {
    requestId,
    action: 'watched',
    value: true,
    mediaType: 'movie',
    tmdbId: 2,
  });
  const write = mock.method(TraktAPI.prototype, 'addToHistory', async () => {
    throw new Error('timeout');
  });
  await assert.rejects(
    () => applyTrackingIntent(userId, 'trakt', intent, 'credential'),
    /timeout/
  );
  assert.equal(
    (
      await getRepository(ProviderTrackingAction).findOneByOrFail({
        userId,
        requestId,
      })
    ).state,
    'unknown'
  );
  await assert.rejects(
    () => applyTrackingIntent(userId, 'trakt', intent, 'credential'),
    /uncertain outcome/
  );
  assert.equal(write.mock.callCount(), 1);
});
it('uses Simkl native removal semantics and accepts its documented empty success body', async () => {
  const userId = await account('simkl');
  const write = mock.method(
    SimklAPI.prototype,
    'removeHistory',
    async () => ''
  );
  const result = await applyTrackingIntent(
    userId,
    'simkl',
    parseTrackingIntent('simkl', {
      requestId,
      action: 'watched',
      value: false,
      mediaType: 'movie',
      tmdbId: 2,
    }),
    'credential'
  );
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(write.mock.calls[0].arguments, ['movie', 2]);
});

it('sends matched TMDB and TVDB identities with Trakt episode updates', async () => {
  const userId = await account('trakt');
  const settings = getSettings();
  const previousMetadata = { ...settings.metadataSettings };
  settings.metadataSettings = {
    ...settings.metadataSettings,
    tv: MetadataProviderType.TMDB,
    anime: MetadataProviderType.TVDB,
  };
  const lookup = mock.method(externalApiPrototype, 'get', async () =>
    tmdbShow(true)
  );
  const write = mock.method(
    TraktAPI.prototype,
    'addEpisodeToHistory',
    async () => ({ added: { episodes: 1 } })
  );

  try {
    const result = await applyTrackingIntent(
      userId,
      'trakt',
      parseTrackingIntent('trakt', {
        requestId: requestId.replace(/1$/, '4'),
        action: 'watched',
        value: true,
        mediaType: 'tv',
        tmdbId: 42,
        episode: { season: 2, episode: 4 },
      }),
      'credential'
    );
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(write.mock.calls[0].arguments, [42, 2, 4, 1399]);
    assert.equal(lookup.mock.callCount(), 1);
  } finally {
    settings.metadataSettings = previousMetadata;
  }
});

it('uses TVDB anime numbering only for anime configured with TVDB metadata', async () => {
  const userId = await account('simkl');
  const settings = getSettings();
  const previousMetadata = { ...settings.metadataSettings };
  settings.metadataSettings = {
    ...settings.metadataSettings,
    tv: MetadataProviderType.TVDB,
    anime: MetadataProviderType.TVDB,
  };
  let lookupCount = 0;
  mock.method(externalApiPrototype, 'get', async () =>
    tmdbShow(lookupCount++ === 0)
  );
  const write = mock.method(
    SimklAPI.prototype,
    'setEpisodeHistory',
    async (_ids, _season, _episode, watched) =>
      watched ? { added: { episodes: 1 } } : ''
  );

  try {
    const anime = await applyTrackingIntent(
      userId,
      'simkl',
      parseTrackingIntent('simkl', {
        requestId: requestId.replace(/1$/, '5'),
        action: 'watched',
        value: true,
        mediaType: 'tv',
        tmdbId: 42,
        episode: { season: 2, episode: 4 },
      }),
      'credential'
    );
    const television = await applyTrackingIntent(
      userId,
      'simkl',
      parseTrackingIntent('simkl', {
        requestId: requestId.replace(/1$/, '6'),
        action: 'watched',
        value: false,
        mediaType: 'tv',
        tmdbId: 42,
        episode: { season: 2, episode: 4 },
      }),
      'credential'
    );

    assert.equal(anime.state, 'succeeded');
    assert.equal(television.state, 'succeeded');
    assert.deepEqual(write.mock.calls[0].arguments, [
      { tmdb: 42, tvdb: 1399 },
      2,
      4,
      true,
      true,
    ]);
    assert.deepEqual(write.mock.calls[1].arguments, [
      { tmdb: 42, tvdb: 1399 },
      2,
      4,
      false,
      false,
    ]);
    assert.equal(lookupCount, 2);
  } finally {
    settings.metadataSettings = previousMetadata;
  }
});

it('does not call a write after account replacement', async () => {
  const userId = await account('simkl');
  const write = mock.method(SimklAPI.prototype, 'setRating', async () => ({
    added: { movies: 1 },
  }));
  await assert.rejects(
    () =>
      applyTrackingIntent(
        userId,
        'simkl',
        parseTrackingIntent('simkl', {
          requestId,
          action: 'rating',
          value: 8,
          mediaType: 'movie',
          tmdbId: 2,
        }),
        'old-credential'
      ),
    /connection/
  );
  assert.equal(write.mock.callCount(), 0);
});
it('validates AniList progress against the current episode total and updates native score units', async () => {
  const userId = await account('anilist');
  mock.method(AnilistAPI.prototype, 'getMedia', async () => ({
    id: 7,
    episodes: 12,
    format: 'TV',
  }));
  const write = mock.method(
    AnilistAPI.prototype,
    'saveMediaListEntry',
    async () => ({ id: 5 })
  );
  await assert.rejects(
    () =>
      applyTrackingIntent(
        userId,
        'anilist',
        parseTrackingIntent('anilist', {
          requestId,
          action: 'progress',
          value: 13,
          anilistId: 7,
        }),
        'credential'
      ),
    /episode count/
  );
  assert.equal(write.mock.callCount(), 0);
  assert.equal(await getRepository(ProviderTrackingAction).count(), 0);
  const result = await applyTrackingIntent(
    userId,
    'anilist',
    parseTrackingIntent('anilist', {
      requestId: requestId.replace(/1$/, '2'),
      action: 'rating',
      value: 8,
      anilistId: 7,
    }),
    'credential'
  );
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(write.mock.calls[0].arguments, [
    { mediaId: 7, scoreRaw: 80 },
  ]);
  const decimal = await applyTrackingIntent(
    userId,
    'anilist',
    parseTrackingIntent('anilist', {
      requestId: requestId.replace(/1$/, '3'),
      action: 'rating',
      value: 7.8,
      anilistId: 7,
    }),
    'credential'
  );
  assert.equal(decimal.state, 'succeeded');
  assert.deepEqual(write.mock.calls[1].arguments, [
    { mediaId: 7, scoreRaw: 78 },
  ]);
});

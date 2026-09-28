import AnilistAPI from '@server/api/anilist';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { DiscoveryIntegrationError } from './accounts';
import { discoveryFeed } from './feeds';
afterEach(() => mock.restoreAll());
it('rejects invalid page bounds before requesting provider data', async () => {
  const fetch = mock.method(AnilistAPI.prototype, 'getTrending', async () => ({
    pageInfo: {},
    media: [],
  }));
  for (const page of [0, 101, 1.5, NaN])
    await assert.rejects(
      () => discoveryFeed(1, 'anilist', 'trending', page),
      (error) =>
        error instanceof DiscoveryIntegrationError && error.status === 400
    );
  assert.equal(fetch.mock.callCount(), 0);
});
it('rejects repeated or non-string MDBList list parameters', async () => {
  await assert.rejects(
    () => discoveryFeed(1, 'mdblist', 'list', 1, ['hdlists/horror']),
    (error) =>
      error instanceof DiscoveryIntegrationError && error.status === 400
  );
  await assert.rejects(
    () => discoveryFeed(1, 'mdblist', 'list', 1, { value: 'hdlists/horror' }),
    (error) =>
      error instanceof DiscoveryIntegrationError && error.status === 400
  );
});
it('retains native AniList identity without inventing a TMDB match', async () => {
  mock.method(AnilistAPI.prototype, 'getTrending', async () => ({
    pageInfo: { hasNextPage: true },
    media: [
      {
        id: 22,
        format: 'TV',
        title: { english: 'Native title' },
        coverImage: {
          large: 'https://s4.anilist.co/file/anilistcdn/cover.jpg',
        },
      },
    ],
  }));
  const result = await discoveryFeed(1, 'anilist', 'trending', 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.missingMappings, 1);
  assert.equal(result.items[0].id, 'anilist:22');
  assert.equal(result.items[0].tmdbId, undefined);
});
it('discards artwork URLs outside the fixed AniList artwork host', async () => {
  mock.method(AnilistAPI.prototype, 'getTrending', async () => ({
    pageInfo: {},
    media: [
      {
        id: 22,
        title: { english: 'Native title' },
        coverImage: {
          large: 'https://s4.anilist.co.attacker.example/cover.jpg',
        },
      },
    ],
  }));
  assert.equal(
    (await discoveryFeed(1, 'anilist', 'trending', 1)).items[0].imageUrl,
    undefined
  );
});

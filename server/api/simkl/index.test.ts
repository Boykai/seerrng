import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import cacheManager from '@server/lib/cache';
import SimklAPI from './index';

describe('Simkl account response caching', () => {
  afterEach(() => {
    mock.restoreAll();
    cacheManager.getCache('simkl').flush();
  });

  it('reuses reads for one account without crossing into another account', async () => {
    cacheManager.getCache('simkl').flush();
    const firstAccount = new SimklAPI({
      clientId: 'shared-client',
      accessToken: 'first-account-token',
    });
    const firstRequest = mock.method(
      (firstAccount as unknown as { rawAxios: AxiosInstance }).rawAxios,
      'get',
      async () => ({ data: { owner: 'first' } })
    );

    assert.deepEqual(await firstAccount.getCatalog('/sync/all-items/shows'), {
      owner: 'first',
    });
    assert.deepEqual(await firstAccount.getCatalog('/sync/all-items/shows'), {
      owner: 'first',
    });
    assert.equal(firstRequest.mock.callCount(), 1);

    const secondAccount = new SimklAPI({
      clientId: 'shared-client',
      accessToken: 'second-account-token',
    });
    const secondRequest = mock.method(
      (secondAccount as unknown as { rawAxios: AxiosInstance }).rawAxios,
      'get',
      async () => ({ data: { owner: 'second' } })
    );

    assert.deepEqual(await secondAccount.getCatalog('/sync/all-items/shows'), {
      owner: 'second',
    });
    assert.equal(secondRequest.mock.callCount(), 1);
  });
});

describe('Simkl episode history payloads', () => {
  it('keeps catalog coordinates and opts into TVDB anime numbering only when requested', () => {
    assert.deepEqual(
      SimklAPI.episodeHistoryPayload({ tmdb: 1429, tvdb: 267440 }, 2, 4, true),
      {
        shows: [
          {
            ids: { tmdb: 1429, tvdb: 267440 },
            use_tvdb_anime_seasons: true,
            seasons: [{ number: 2, episodes: [{ number: 4 }] }],
          },
        ],
      }
    );
    assert.deepEqual(
      SimklAPI.episodeHistoryPayload({ tmdb: 1429, tvdb: 267440 }, 1, 7),
      {
        shows: [
          {
            ids: { tmdb: 1429, tvdb: 267440 },
            seasons: [{ number: 1, episodes: [{ number: 7 }] }],
          },
        ],
      }
    );
  });

  it('requires at least one series identity', () => {
    assert.throws(
      () => SimklAPI.episodeHistoryPayload({}, 1, 1),
      /requires at least one id/
    );
  });
});

describe('Simkl watched episode lookup', () => {
  it('posts a bounded, episode-expanded watch-state read', async () => {
    const api = new SimklAPI({
      clientId: 'watched-read-client',
      accessToken: 'watched-read-token',
    });
    const posted = mock.method(
      (api as unknown as { rawAxios: AxiosInstance }).rawAxios,
      'post',
      async () => ({ data: [] })
    );

    const result = await api.getWatchedEpisodes([{ simkl: 42 }]);

    assert.deepEqual(result, []);
    assert.equal(posted.mock.callCount(), 1);
    const [path, body] = posted.mock.calls[0].arguments;
    const requestUrl = new URL(String(path), 'https://api.simkl.com');
    assert.equal(requestUrl.pathname, '/sync/watched');
    assert.equal(
      requestUrl.searchParams.get('extended'),
      'episodes,specials,counters'
    );
    assert.equal(
      requestUrl.searchParams.get('client_id'),
      'watched-read-client'
    );
    assert.deepEqual(body, [{ simkl: 42 }]);
  });

  it('rejects empty, oversized, or unidentified watch-state lookups', async () => {
    const api = new SimklAPI({
      clientId: 'watched-read-invalid-client',
      accessToken: 'watched-read-invalid-token',
    });
    await assert.rejects(() => api.getWatchedEpisodes([]), /Invalid Simkl/);
    await assert.rejects(
      () =>
        api.getWatchedEpisodes(
          Array.from({ length: 101 }, () => ({ simkl: 1 }))
        ),
      /Invalid Simkl/
    );
    await assert.rejects(
      () => api.getWatchedEpisodes([{ season: 1 } as never]),
      /Invalid Simkl/
    );
    await assert.rejects(
      () => api.getWatchedEpisodes([null as never]),
      /Invalid Simkl/
    );
    await assert.rejects(
      () => api.getWatchedEpisodes([{ simkl: 2147483648 }]),
      /Invalid Simkl/
    );
  });
});

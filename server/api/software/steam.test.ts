import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AxiosInstance } from 'axios';
import SteamAPI, {
  MAX_STEAM_GAMES_PER_SYNC,
  STEAM_OPENID_ENDPOINT,
  SteamLibraryUnavailableError,
} from './steam';

const makeClient = (
  options: {
    getData?: unknown;
    postData?: string;
    onGet?: (url: string, config?: unknown) => void;
    onPost?: (url: string, data: unknown, config?: unknown) => void;
  } = {}
): AxiosInstance =>
  ({
    get: async (url: string, config?: unknown) => {
      options.onGet?.(url, config);
      return { data: options.getData };
    },
    post: async (url: string, data: unknown, config?: unknown) => {
      options.onPost?.(url, data, config);
      return {
        data:
          options.postData ??
          'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n',
      };
    },
  }) as unknown as AxiosInstance;

describe('Steam API boundary', () => {
  it('verifies a Steam OpenID assertion with Steam and preserves signed fields', async () => {
    let postedUrl = '';
    let postedBody = '';
    const api = new SteamAPI(
      '',
      makeClient({
        onPost: (url, data) => {
          postedUrl = url;
          postedBody = String(data);
        },
      })
    );

    const verified = await api.verifyOpenIdAssertion({
      'openid.claimed_id':
        'https://steamcommunity.com/openid/id/76561198000000002',
      'openid.identity':
        'https://steamcommunity.com/openid/id/76561198000000002',
      'openid.return_to':
        'https://seerr.test/api/v1/game-library/steam/callback',
      'openid.mode': 'id_res',
      'openid.ns': 'http://specs.openid.net/auth/2.0',
    });

    assert.equal(verified, true);
    assert.equal(postedUrl, STEAM_OPENID_ENDPOINT);
    assert.match(postedBody, /openid\.mode=check_authentication/);
    assert.match(postedBody, /openid\.claimed_id=https%3A%2F%2Fsteamcommunity/);
    assert.doesNotMatch(postedBody, /openid\.mode=id_res/);
  });

  it('rejects a false OpenID assertion response', async () => {
    const api = new SteamAPI(
      '',
      makeClient({
        postData: 'ns:http://specs.openid.net/auth/2.0\nis_valid:false\n',
      })
    );
    assert.equal(
      await api.verifyOpenIdAssertion({ 'openid.mode': 'id_res' }),
      false
    );
  });

  it('imports a complete, validated owned-games response using the server key', async () => {
    let requestUrl = '';
    let requestConfig: unknown;
    const api = new SteamAPI(
      'server-only-key',
      makeClient({
        getData: {
          response: {
            game_count: 2,
            games: [
              { appid: 10, name: 'Game One', playtime_forever: 60 },
              { appid: 20, name: 'Game Two', playtime_forever: 0 },
            ],
          },
        },
        onGet: (url, config) => {
          requestUrl = url;
          requestConfig = config;
        },
      })
    );

    assert.deepEqual(await api.getOwnedGames('76561198000000002'), [
      { appId: 10, name: 'Game One', playtimeMinutes: 60 },
      { appId: 20, name: 'Game Two', playtimeMinutes: 0 },
    ]);
    assert.match(requestUrl, /GetOwnedGames\/v1/);
    assert.deepEqual((requestConfig as { params: object }).params, {
      key: 'server-only-key',
      steamid: '76561198000000002',
      include_appinfo: 1,
      include_played_free_games: 1,
    });
  });

  it('rejects private, incomplete, oversized, duplicate, and malformed libraries', async () => {
    const responses: unknown[] = [
      { response: { game_count: 0 } },
      { response: { game_count: 1, games: [] } },
      {
        response: {
          game_count: MAX_STEAM_GAMES_PER_SYNC + 1,
          games: [],
        },
      },
      {
        response: {
          game_count: 2,
          games: [
            { appid: 1, name: 'Duplicate', playtime_forever: 1 },
            { appid: 1, name: 'Duplicate', playtime_forever: 1 },
          ],
        },
      },
      {
        response: {
          game_count: 1,
          games: [{ appid: 1, name: '', playtime_forever: -1 }],
        },
      },
    ];

    for (const data of responses) {
      const api = new SteamAPI('key', makeClient({ getData: data }));
      await assert.rejects(api.getOwnedGames('76561198000000002'), {
        name: 'SteamLibraryUnavailableError',
      });
    }
  });

  it('does not make a Steam library request without a configured key', async () => {
    const api = new SteamAPI('', makeClient());
    await assert.rejects(
      api.getOwnedGames('76561198000000002'),
      SteamLibraryUnavailableError
    );
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(path.resolve('package.json'));
const ts = require('typescript');
const express = require('express');
const request = require('supertest');
const root = process.env.SAVED_ITEM_TEST_SOURCE_ROOT ?? '.';
const source = (file) => fs.readFileSync(path.resolve(root, file), 'utf8');
const compile = (file, imports) => {
  const compiledModule = { exports: {} };
  const javascript = ts.transpileModule(source(file), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  new Function('require', 'module', 'exports', javascript)(
    imports,
    compiledModule,
    compiledModule.exports
  );
  return compiledModule.exports;
};
class MockExternalAPI {
  constructor(base, params, options) {
    this.base = base;
    this.options = options;
    this.calls = [];
    this.responses = [];
  }
  async request(method, endpoint, body, config) {
    this.calls.push({ method, endpoint, body, config });
    assert.ok(this.responses.length, 'Every provider request must be mocked');
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return { data: next };
  }
}
const provider = compile('server/api/mediaServerSavedItem.ts', (id) => {
  if (id === 'axios') return require('axios');
  if (id === 'xml2js') return require('xml2js');
  if (id.endsWith('/jellyfinEmbySavedItems'))
    return { FavoriteSeriesAPI: class {} };
  if (id.endsWith('/externalapi'))
    return { default: MockExternalAPI, __esModule: true };
  if (id.endsWith('/plextv'))
    return {
      PLEXTV_HTTP_OPTIONS: {
        timeout: 10000,
        maxContentLength: 1048576,
        maxBodyLength: 1024,
      },
      parsePlexDevices: (value) =>
        value.MediaContainer.Device.map(({ $: attributes }) => ({
          owned: attributes.owned === '1',
          provides: attributes.provides.split(','),
          clientIdentifier: attributes.clientIdentifier,
        })),
    };
  if (id.endsWith('/concurrency'))
    return {
      mapWithConcurrency: async (items, limit, callback) =>
        Promise.all(items.map(callback)),
    };
  throw new Error('Unexpected dependency ' + id);
});
const id = '5d9c08ab391719001f6c8e7b';
const metadata = {
  type: 'show',
  guid: `plex://show/${id}`,
  Guid: [{ id: 'tmdb://42' }],
};
test('Owner capability returns only linked-account owned server IDs, never resource tokens', async () => {
  const api = new provider.PlexSavedItemAPI('current-user-token');
  api.responses.push(
    '<MediaContainer><Device owned="1" provides="server" clientIdentifier="ours" accessToken="never-return"/><Device owned="0" provides="server" clientIdentifier="shared"/><Device owned="1" provides="client" clientIdentifier="player"/></MediaContainer>'
  );
  assert.deepEqual(await api.getOwnedServerIds(), ['ours']);
  assert.equal(api.calls[0].endpoint, '/api/resources?includeHttps=1');
  assert.equal(api.calls[0].method, 'GET');
});
test('Plex action uses a verified cloud Show ID and current account token', async () => {
  const api = new provider.PlexSavedItemAPI('current-user-token');
  assert.deepEqual(api.options.headers, {
    'X-Plex-Token': 'current-user-token',
    Accept: 'application/json',
  });
  api.responses.push({ user: { id: 7 } }, {}, {});
  await api.verifyAccount(7);
  await api.setSaved(id, true);
  await api.setSaved(id, false);
  assert.deepEqual(
    api.calls
      .slice(1)
      .map(({ method, endpoint, config }) => [method, endpoint, config]),
    [
      [
        'PUT',
        '/actions/addToWatchlist',
        {
          baseURL: 'https://discover.provider.plex.tv',
          params: { ratingKey: id },
        },
      ],
      [
        'PUT',
        '/actions/removeFromWatchlist',
        {
          baseURL: 'https://discover.provider.plex.tv',
          params: { ratingKey: id },
        },
      ],
    ]
  );
  await assert.rejects(api.setSaved('42', true));
  await assert.rejects(api.setSaved('../actions', true));
  assert.equal(api.calls.length, 3);
});
test('Plex rejects another account and mismatched or non-Series provider identities', async () => {
  const api = new provider.PlexSavedItemAPI('user');
  api.responses.push({ user: { id: 8 } });
  await assert.rejects(api.verifyAccount(7));
  assert.equal(provider.exactPlexSeries(metadata, 42), id);
  assert.equal(provider.exactPlexSeries(metadata, 43), undefined);
  assert.equal(
    provider.exactPlexSeries({ ...metadata, type: 'episode' }, 42),
    undefined
  );
  assert.equal(
    provider.exactPlexSeries({ ...metadata, guid: 'plex://show/42' }, 42),
    undefined
  );
});
test('Plex hydrates the catalog candidate and checks exact TMDB identity, never title alone', async () => {
  const api = new provider.PlexSavedItemAPI('user');
  api.responses.push(
    {
      MediaContainer: {
        SearchResults: [
          { id: 'external', SearchResult: [{ Metadata: metadata }] },
        ],
      },
    },
    { MediaContainer: { Metadata: [metadata] } }
  );
  assert.equal(await api.resolveSeries(42, 'Series Name'), id);
  assert.equal(api.calls[0].config.params.query, 'Series Name');
  assert.equal(api.calls[1].endpoint, `/library/metadata/${id}`);
  api.responses.push(
    {
      MediaContainer: {
        SearchResults: [
          { id: 'external', SearchResult: [{ Metadata: metadata }] },
        ],
      },
    },
    {
      MediaContainer: {
        Metadata: [{ ...metadata, Guid: [{ id: 'tmdb://43' }] }],
      },
    }
  );
  assert.equal(await api.resolveSeries(42, 'Series Name'), undefined);
});
test('Plex saved state distinguishes missing timestamp from malformed/missing source', () => {
  assert.equal(
    provider.parsePlexSavedState({ MediaContainer: { UserState: [{}] } }),
    false
  );
  assert.equal(
    provider.parsePlexSavedState({
      MediaContainer: { UserState: [{ watchlistedAt: 123 }] },
    }),
    true
  );
  assert.throws(() => provider.parsePlexSavedState({ MediaContainer: {} }));
  assert.throws(() =>
    provider.parsePlexSavedState({
      MediaContainer: { UserState: [{ watchlistedAt: 'bad' }] },
    })
  );
});

const buildRoute = ({
  type = 1,
  user = { id: 7, plexId: 9, plexToken: 'own-token' },
  saved = false,
  failure,
  confirm = true,
  authorized = true,
  qualityRoots = {},
  onResolve,
  onCatalog,
  onSavedRead,
  onFavoriteRead,
  metadataRecord = { id: 42, name: 'Trusted Title' },
  mediaRecord = { tmdbId: 42, mediaType: 'tv' },
  withOpenApi = false,
} = {}) => {
  const calls = [];
  const admissions = [];
  const logs = [];
  const queries = [];
  const state = {
    user,
    authorized,
    type,
    plex: {
      ip: 'configured-server',
      port: 32400,
      useSsl: false,
      machineId: 'ours',
    },
    jellyfin: {
      ip: 'configured-server',
      port: 8096,
      useSsl: false,
      urlBase: '',
      serverId: 'ours',
    },
  };
  const instance = {
    verifyAccount: async () => {
      calls.push('verify');
    },
    resolveSeries: async () => {
      await onCatalog?.(state);
      return id;
    },
    getSaved: async () => {
      await onSavedRead?.(state);
      return saved;
    },
    setSaved: async (...args) => {
      calls.push(args);
      if (failure) throw failure;
      if (confirm) saved = args[1];
    },
  };
  class Unauthorized extends Error {}
  const dependencies = {
    '@server/logger': {
      __esModule: true,
      default: {
        warn: (message, fields) => logs.push({ message, fields }),
      },
    },
    '@server/api/mediaServerSavedItem': {
      getPlexWatchlistDiagnostic: provider.getPlexWatchlistDiagnostic,
      PlexWatchlistError: provider.PlexWatchlistError,
      runPlexWatchlistPhase: provider.runPlexWatchlistPhase,
      PlexSavedItemAPI: class {
        constructor(token) {
          assert.equal(token, state.user.plexToken);
          return instance;
        }
      },
      FavoriteSeriesAPI: class {
        constructor(host, token, nativeUserId, options) {
          assert.equal(token, state.user.jellyfinAuthToken);
          assert.equal(nativeUserId, state.user.jellyfinUserId);
          assert.deepEqual(options, {
            serverType: type,
            trustedAccountPair: true,
          });
        }
        async verifyAccount() {
          calls.push('favorite-verify');
        }
        async getSeriesSaved(itemId, tmdbId) {
          calls.push(['series', itemId, tmdbId]);
          await onFavoriteRead?.(state);
          return saved;
        }
        async setSaved(itemId, desired) {
          calls.push(['favorite', itemId, desired]);
          saved = desired;
          return saved;
        }
      },
    },
    '@server/api/metadata': {
      getMetadataProvider: () => ({
        getTvShow: async () => {
          await onResolve?.(state);
          return metadataRecord;
        },
      }),
    },
    '@server/constants/media': { MediaType: { TV: 'tv' } },
    '@server/constants/server': {
      MediaServerType: { PLEX: 1, JELLYFIN: 2, EMBY: 3 },
    },
    '@server/datasource': {
      getRepository: () => ({
        findOneOrFail: async (query) => {
          assert.equal(query.where.id, 7);
          return user;
        },
        findOne: async (query) => {
          assert.deepEqual(query.where, { tmdbId: 42, mediaType: 'tv' });
          await onResolve?.(state);
          return mediaRecord;
        },
      }),
    },
    '@server/entity/Media': { default: class {}, __esModule: true },
    '@server/entity/User': { User: class {} },
    '@server/lib/playbackMediaRoot': {
      getPlaybackMediaRootId: (media, serverType, is4k) => {
        calls.push(['root', serverType, is4k]);
        return qualityRoots[is4k ? '4k' : 'hd'];
      },
    },
    '@server/lib/settings': {
      getSettings: () => ({
        main: { mediaServerType: state.type },
        plex: state.plex,
        jellyfin: state.jellyfin,
      }),
    },
    '@server/lib/userSecurityMutation': {
      UserMutationActorUnauthorizedError: Unauthorized,
      runUserSecurityMutationWithActor: async (
        actor,
        target,
        permissions,
        callback,
        options
      ) => {
        assert.equal(actor, 7);
        assert.equal(target, 7);
        assert.deepEqual(options, { includeMediaServerCredentials: true });
        admissions.push(actor);
        if (!state.authorized) throw new Unauthorized();
        return callback(state.user);
      },
    },
    '@server/utils/getHostname': {
      getHostname: () => 'http://configured-server',
    },
    '@server/utils/routeId': {
      parsePositiveRouteId: (value, maximum) =>
        /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= maximum
          ? Number(value)
          : undefined,
    },
    '@server/utils/security': { getRateLimitKey: () => 'test' },
    express,
    'express-rate-limit': {
      default: () => (req, res, next) => next(),
      __esModule: true,
    },
  };
  dependencies[
    '@server/lib/userSecurityMutation'
  ].runUserSecurityReadWithActor =
    dependencies[
      '@server/lib/userSecurityMutation'
    ].runUserSecurityMutationWithActor;
  const routes = compile('server/routes/tvSavedItem.ts', (key) => {
    assert.ok(key in dependencies, key);
    return dependencies[key];
  }).default;
  const app = express();
  app.use(express.json());
  if (withOpenApi) {
    app.use(
      require('express-openapi-validator').middleware({
        apiSpec: path.resolve('seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    app.use((req, res, next) => {
      queries.push({ value: req.query.is4k, valueType: typeof req.query.is4k });
      next();
    });
  }
  app.use((req, res, next) => {
    req.user = { id: 7, plexToken: 'stale-or-admin-token' };
    next();
  });
  if (withOpenApi) app.use('/api/v1/tv', routes);
  else app.use(routes);
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(error.status || 500).json({ invalid: true });
  });
  return { app, calls, state, admissions, logs, queries };
};
test('Saved-item writes are current-user-only, strict-body, and idempotent', async () => {
  const { app, calls } = buildRoute();
  assert.equal(
    (
      await request(app)
        .post('/42/media-server-saved-item')
        .send({ saved: true, userId: 8 })
    ).status,
    400
  );
  assert.equal(
    (
      await request(app)
        .post('/0/media-server-saved-item')
        .send({ saved: true })
    ).status,
    400
  );
  const response = await request(app)
    .post('/42/media-server-saved-item')
    .send({ saved: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.saved, true);
  assert.deepEqual(calls, ['verify', [id, true]]);
  const already = buildRoute({ saved: true });
  assert.equal(
    (
      await request(already.app)
        .post('/42/media-server-saved-item')
        .send({ saved: true })
    ).status,
    200
  );
  assert.deepEqual(already.calls, ['verify']);
});
test('Reading saved state never calls a provider mutation', async () => {
  const { app, calls } = buildRoute({ saved: true });
  const response = await request(app).get('/42/media-server-saved-item');
  assert.equal(response.status, 200);
  assert.equal(response.body.saved, true);
  assert.deepEqual(calls, ['verify']);
});
test('Native Favorites use only the quality-selected trusted Series root', async () => {
  for (const type of [2, 3]) {
    const fixture = buildRoute({
      type,
      user: {
        id: 7,
        jellyfinUserId: 'native-user',
        jellyfinAuthToken: 'own-native-token',
      },
      qualityRoots: { hd: 'hd-root', '4k': 'four-k-root' },
    });
    assert.equal(
      (await request(fixture.app).get('/42/media-server-saved-item?is4k=true'))
        .status,
      200
    );
    assert.deepEqual(fixture.calls, [
      ['root', type, true],
      'favorite-verify',
      ['series', 'four-k-root', 42],
    ]);
    fixture.calls.length = 0;
    assert.equal(
      (
        await request(fixture.app)
          .post('/42/media-server-saved-item')
          .send({ saved: true, is4k: false })
      ).status,
      200
    );
    assert.deepEqual(fixture.calls, [
      ['root', type, false],
      'favorite-verify',
      ['series', 'hd-root', 42],
      ['favorite', 'hd-root', true],
    ]);
    const unavailable = buildRoute({
      type,
      user: {
        id: 7,
        jellyfinUserId: 'native-user',
        jellyfinAuthToken: 'own-native-token',
      },
      qualityRoots: { hd: 'hd-root' },
    });
    const response = await request(unavailable.app).get(
      '/42/media-server-saved-item?is4k=true'
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.reason, 'series-not-found');
    assert.deepEqual(unavailable.calls, [['root', type, true]]);
  }
});
test('Quality selection rejects ambiguous types and client item/account authority', async () => {
  const fixture = buildRoute();
  for (const query of [
    'is4k=1',
    'is4k=',
    'is4k=true&is4k=false',
    'is4k[flag]=true',
    'itemId=81',
    'userId=8',
  ])
    assert.equal(
      (await request(fixture.app).get(`/42/media-server-saved-item?${query}`))
        .status,
      400
    );
  for (const body of [
    { saved: true, is4k: 'true' },
    { saved: true, is4k: 1 },
    { saved: true, is4k: null },
    { saved: true, itemId: '81' },
  ])
    assert.equal(
      (
        await request(fixture.app)
          .post('/42/media-server-saved-item')
          .send(body)
      ).status,
      400
    );
  assert.equal(
    (
      await request(fixture.app)
        .post('/42/media-server-saved-item?is4k=true')
        .send({ saved: true })
    ).status,
    400
  );
  assert.deepEqual(fixture.calls, []);
  assert.equal(
    (
      await request(fixture.app)
        .post('/42/media-server-saved-item')
        .send({ saved: true, is4k: true })
    ).status,
    200
  );
  assert.deepEqual(fixture.calls, ['verify', [id, true]]);
});
test('Missing linked account and revoked authority cannot reach provider writes', async () => {
  const missing = buildRoute({ user: { id: 7 } });
  assert.equal(
    (
      await request(missing.app)
        .post('/42/media-server-saved-item')
        .send({ saved: true })
    ).status,
    409
  );
  assert.deepEqual(missing.calls, []);
  const revoked = buildRoute({ authorized: false });
  assert.equal(
    (
      await request(revoked.app)
        .post('/42/media-server-saved-item')
        .send({ saved: true })
    ).status,
    403
  );
  assert.deepEqual(revoked.calls, []);
});
test('Provider failure is sanitized and never reported as saved success', async () => {
  const { app } = buildRoute({
    failure: new Error('https://plex.tv?token=provider-secret'),
  });
  const response = await request(app)
    .post('/42/media-server-saved-item')
    .send({ saved: true });
  assert.equal(response.status, 502);
  assert.ok(!JSON.stringify(response.body).includes('provider-secret'));
  assert.equal(response.body.saved, undefined);
});
test('An acknowledged Plex write without matching readback is not saved success', async () => {
  const { app } = buildRoute({ confirm: false });
  const response = await request(app)
    .post('/42/media-server-saved-item')
    .send({ saved: true });
  assert.equal(response.status, 502);
  assert.equal(response.body.saved, undefined);
  assert.deepEqual(response.body.diagnostic, {
    phase: 'watchlist-confirmation',
    category: 'confirmation-mismatch',
  });
});
// Rendered client safety coverage lives in mediaServerSavedItemClient.test.mjs.

test('GET rejects nonempty or nonobject bodies before account or provider work', async () => {
  const fixture = buildRoute();
  for (const body of [{ saved: true }, { userId: 8 }, []]) {
    const response = await request(fixture.app)
      .get('/42/media-server-saved-item')
      .send(body);
    assert.equal(response.status, 400);
  }
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.admissions, []);
  assert.equal(
    (await request(fixture.app).get('/42/media-server-saved-item').send({}))
      .status,
    200
  );
});

test('Actor admission is checked again after metadata or native root resolution', async () => {
  for (const type of [1, 2, 3]) {
    for (const method of ['get', 'post']) {
      for (const change of [
        (state) => {
          state.authorized = false;
        },
        (state) => {
          state.user = { ...state.user, id: 8 };
        },
        (state) => {
          state.user = {
            ...state.user,
            plexToken: undefined,
            jellyfinAuthToken: undefined,
          };
        },
        (state) => {
          state.user = {
            ...state.user,
            plexToken: 'changed-credential',
            jellyfinAuthToken: 'changed-native-credential',
          };
        },
        (state) => {
          state.type = type === 1 ? 2 : 1;
        },
        (state) => {
          (type === 1 ? state.plex : state.jellyfin).ip = 'other-server';
        },
        (state) => {
          (type === 1 ? state.plex : state.jellyfin).port = 9999;
        },
        (state) => {
          (type === 1 ? state.plex : state.jellyfin).useSsl = true;
        },
        (state) => {
          if (type === 1) state.plex.machineId = 'other';
          else state.jellyfin.serverId = 'other';
        },
      ]) {
        const fixture = buildRoute({
          type,
          user: {
            id: 7,
            plexId: 9,
            plexToken: 'own-token',
            jellyfinUserId: 'own-user',
            jellyfinAuthToken: 'own-native-token',
          },
          qualityRoots: { hd: 'hd-root' },
          onResolve: change,
        });
        const pending = request(fixture.app)[method](
          '/42/media-server-saved-item'
        );
        const response = await (method === 'post'
          ? pending.send({ saved: true })
          : pending);
        assert.equal(response.status, 403);
        assert.deepEqual(fixture.calls, []);
        assert.equal(response.body.saved, undefined);
        assert.ok(fixture.admissions.length >= 2);
      }
    }
  }
});

test('Native Favorites reject mismatched stored media identity before root or provider requests', async () => {
  for (const mediaRecord of [
    undefined,
    { tmdbId: 43, mediaType: 'tv' },
    { tmdbId: 42, mediaType: 'movie' },
  ]) {
    const fixture = buildRoute({
      type: 2,
      user: {
        id: 7,
        jellyfinUserId: 'own-user',
        jellyfinAuthToken: 'own-native-token',
      },
      qualityRoots: { hd: 'root' },
      mediaRecord: mediaRecord ?? null,
    });
    const response = await request(fixture.app)
      .post('/42/media-server-saved-item')
      .send({ saved: true });
    assert.equal(response.status, 409);
    assert.deepEqual(fixture.calls, []);
  }
});

test('Plex requires exact metadata Series ID and meaningful title before provider resolution', async () => {
  for (const metadataRecord of [
    { id: 43, name: 'Wrong series' },
    { id: 42, name: '   ' },
  ]) {
    const fixture = buildRoute({ metadataRecord });
    const response = await request(fixture.app).get(
      '/42/media-server-saved-item'
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.reason, 'series-not-found');
    assert.deepEqual(fixture.calls, []);
  }
});

test('Account or native configuration changes during provider reads prevent all writes', async () => {
  const plexCases = [
    {
      onCatalog: (state) => {
        state.user = { ...state.user, plexToken: 'new-token' };
      },
    },
    {
      onSavedRead: (state) => {
        state.plex.machineId = 'different-server';
      },
    },
  ];
  for (const options of plexCases) {
    const fixture = buildRoute(options);
    const response = await request(fixture.app)
      .post('/42/media-server-saved-item')
      .send({ saved: true });
    assert.equal(response.status, 403);
    assert.deepEqual(fixture.calls, ['verify']);
  }
  for (const type of [2, 3]) {
    const fixture = buildRoute({
      type,
      user: {
        id: 7,
        jellyfinUserId: 'own-user',
        jellyfinAuthToken: 'own-native-token',
      },
      qualityRoots: { hd: 'root' },
      onFavoriteRead: (state) => {
        state.jellyfin.urlBase = 'changed';
      },
    });
    const response = await request(fixture.app)
      .post('/42/media-server-saved-item')
      .send({ saved: true });
    assert.equal(response.status, 403);
    assert.deepEqual(fixture.calls, [
      ['root', type, false],
      'favorite-verify',
      ['series', 'root', 42],
    ]);
  }
});

const sensitiveFailure = (status = 401) =>
  Object.assign(new Error('https://provider.example?token=DO-NOT-DISCLOSE'), {
    isAxiosError: true,
    response: {
      status,
      data: { token: 'DO-NOT-DISCLOSE', userId: 'PRIVATE-USER' },
      headers: { authorization: 'DO-NOT-DISCLOSE' },
    },
    config: {
      url: 'https://provider.example/private-title',
      headers: { 'X-Plex-Token': 'DO-NOT-DISCLOSE' },
    },
  });
const searchResponse = {
  MediaContainer: {
    SearchResults: [{ id: 'external', SearchResult: [{ Metadata: metadata }] }],
  },
};

test('Plex transport failures expose only the fixed failing phase and numeric upstream status', async () => {
  for (const [phase, prepare, invoke] of [
    ['account', [], (api) => api.verifyAccount(7)],
    ['catalog-search', [], (api) => api.resolveSeries(42, 'Private Title')],
    [
      'catalog-identity',
      [searchResponse],
      (api) => api.resolveSeries(42, 'Private Title'),
    ],
    ['watchlist-state', [], (api) => api.getSaved(id)],
    ['watchlist-write', [], (api) => api.setSaved(id, true)],
    [
      'watchlist-confirmation',
      [],
      (api) => api.getSaved(id, 'watchlist-confirmation'),
    ],
  ]) {
    const api = new provider.PlexSavedItemAPI('DO-NOT-DISCLOSE');
    api.responses.push(...prepare, sensitiveFailure(403));
    await assert.rejects(invoke(api), (error) => {
      assert.deepEqual(provider.getPlexWatchlistDiagnostic(error), {
        phase,
        category: 'http',
        upstreamStatus: 403,
      });
      assert.equal(error.message, 'Plex Watchlist operation failed.');
      assert.equal(error.cause, undefined);
      assert.equal(error.response, undefined);
      assert.equal(error.config, undefined);
      const serialized = JSON.stringify(error);
      assert.ok(!serialized.includes('DO-NOT-DISCLOSE'));
      assert.ok(!serialized.includes('PRIVATE-USER'));
      assert.ok(!serialized.includes('https://'));
      assert.ok(!serialized.includes('Private Title'));
      return true;
    });
    assert.equal(api.responses.length, 0);
  }
});

test('Plex malformed responses preserve schema phase without publishing response fields', async () => {
  for (const [phase, responses, invoke] of [
    ['account', [{ token: 'DO-NOT-DISCLOSE' }], (api) => api.verifyAccount(7)],
    [
      'catalog-search',
      [{ MediaContainer: { body: 'DO-NOT-DISCLOSE' } }],
      (api) => api.resolveSeries(42, 'Private Title'),
    ],
    [
      'catalog-identity',
      [searchResponse, { MediaContainer: { Metadata: [] } }],
      (api) => api.resolveSeries(42, 'Private Title'),
    ],
    [
      'watchlist-state',
      [
        {
          MediaContainer: { UserState: [{ watchlistedAt: 'DO-NOT-DISCLOSE' }] },
        },
      ],
      (api) => api.getSaved(id),
    ],
    [
      'watchlist-confirmation',
      [{ MediaContainer: { UserState: [] } }],
      (api) => api.getSaved(id, 'watchlist-confirmation'),
    ],
  ]) {
    const api = new provider.PlexSavedItemAPI('DO-NOT-DISCLOSE');
    api.responses.push(...responses);
    await assert.rejects(invoke(api), (error) => {
      assert.deepEqual(provider.getPlexWatchlistDiagnostic(error), {
        phase,
        category: 'invalid-response',
      });
      assert.ok(!JSON.stringify(error).includes('DO-NOT-DISCLOSE'));
      return true;
    });
  }
});

test('Diagnostics reject untrusted fields, invalid enum/status values and raw errors', async () => {
  assert.equal(
    provider.getPlexWatchlistDiagnostic(sensitiveFailure()),
    undefined
  );
  for (const status of ['401', NaN, Infinity, 399, 600, { token: 'secret' }]) {
    await assert.rejects(
      provider.runPlexWatchlistPhase('account', async () => {
        throw sensitiveFailure(status);
      }),
      (error) => {
        assert.deepEqual(provider.getPlexWatchlistDiagnostic(error), {
          phase: 'account',
          category: 'transport',
        });
        return true;
      }
    );
  }
  const safe = new provider.PlexWatchlistError('account', 'http', 401);
  safe.token = 'DO-NOT-DISCLOSE';
  safe.rawBody = { secret: 'DO-NOT-DISCLOSE' };
  assert.deepEqual(provider.getPlexWatchlistDiagnostic(safe), {
    phase: 'account',
    category: 'http',
    upstreamStatus: 401,
  });
  assert.equal(
    provider.getPlexWatchlistDiagnostic(
      new provider.PlexWatchlistError('https://secret', 'http', 401)
    ),
    undefined
  );
  assert.equal(
    provider.getPlexWatchlistDiagnostic(
      new provider.PlexWatchlistError('account', 'secret-category', 401)
    ),
    undefined
  );
});

test('Route diagnostics never expose upstream bodies, credentials, URLs or raw errors', async () => {
  for (const phase of [
    'series-metadata',
    'account',
    'catalog-search',
    'catalog-identity',
    'watchlist-state',
    'watchlist-write',
    'watchlist-confirmation',
  ]) {
    let safe;
    try {
      await provider.runPlexWatchlistPhase(phase, async () => {
        throw sensitiveFailure(401);
      });
    } catch (error) {
      safe = error;
    }
    // Even extended exception fields must not cross the route response boundary.
    safe.rawBody = { token: 'DO-NOT-DISCLOSE' };
    safe.config = { url: 'https://provider.example?token=DO-NOT-DISCLOSE' };
    const fixture = buildRoute({ failure: safe });
    const response = await request(fixture.app)
      .post('/42/media-server-saved-item')
      .send({ saved: true });
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, {
      message:
        'The media-server saved state could not be loaded or updated. Please retry.',
      diagnostic: { phase, category: 'http', upstreamStatus: 401 },
    });
    assert.deepEqual(fixture.logs, [
      {
        message: 'Plex Watchlist operation failed.',
        fields: {
          label: 'Plex Watchlist Diagnostics',
          phase,
          category: 'http',
          upstreamStatus: 401,
        },
      },
    ]);
    assert.ok(!JSON.stringify(fixture.logs).includes('DO-NOT-DISCLOSE'));
    assert.ok(!JSON.stringify(fixture.logs).includes('PRIVATE-USER'));
    assert.ok(!JSON.stringify(fixture.logs).includes('https://'));
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes('DO-NOT-DISCLOSE'));
    assert.ok(!serialized.includes('PRIVATE-USER'));
    assert.ok(!serialized.includes('https://'));
    assert.equal(response.body.saved, undefined);
  }
  const source = buildRoute({
    onResolve: () => {
      throw sensitiveFailure(503);
    },
  });
  const failed = await request(source.app).get('/42/media-server-saved-item');
  assert.deepEqual(failed.body.diagnostic, {
    phase: 'series-metadata',
    category: 'http',
    upstreamStatus: 503,
  });
  assert.deepEqual(source.calls, []);
});

test('Fixed Watchlist diagnostics leave other-provider failures and security errors unchanged', async () => {
  for (const type of [2, 3]) {
    const other = buildRoute({
      type,
      user: {
        id: 7,
        jellyfinUserId: 'native-user',
        jellyfinAuthToken: 'DO-NOT-DISCLOSE',
      },
      qualityRoots: { hd: 'trusted-root' },
      onFavoriteRead: () => {
        throw sensitiveFailure(401);
      },
    });
    const failed = await request(other.app).get('/42/media-server-saved-item');
    assert.equal(failed.status, 502);
    assert.deepEqual(failed.body, {
      message:
        'The media-server saved state could not be loaded or updated. Please retry.',
    });
    assert.ok(!JSON.stringify(failed.body).includes('DO-NOT-DISCLOSE'));
    assert.deepEqual(other.logs, []);
  }
  const unknown = buildRoute({
    failure: new Error('https://provider.example?token=DO-NOT-DISCLOSE'),
  });
  const response = await request(unknown.app)
    .post('/42/media-server-saved-item')
    .send({ saved: true });
  assert.deepEqual(response.body, {
    message:
      'The media-server saved state could not be loaded or updated. Please retry.',
  });
  assert.deepEqual(unknown.logs, []);
  const deniedFixture = buildRoute({ authorized: false });
  const denied = await request(deniedFixture.app).get(
    '/42/media-server-saved-item'
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.body.diagnostic, undefined);
  assert.deepEqual(deniedFixture.logs, []);
});

test('Installed OpenAPI middleware preserves false/default and true quality through native saved GET', async () => {
  for (const type of [2, 3]) {
    const fixture = buildRoute({
      type,
      withOpenApi: true,
      user: {
        id: 7,
        jellyfinUserId: 'native-user',
        jellyfinAuthToken: 'mock-only-token',
      },
      qualityRoots: { hd: 'hd-root', '4k': 'four-k-root' },
    });
    for (const [query, is4k] of [
      ['', false],
      ['?is4k=false', false],
      ['?is4k=true', true],
    ]) {
      fixture.calls.length = 0;
      const response = await request(fixture.app).get(
        `/api/v1/tv/42/media-server-saved-item${query}`
      );
      assert.equal(response.status, 200);
      assert.deepEqual(fixture.queries.at(-1), {
        value: is4k,
        valueType: 'boolean',
      });
      assert.deepEqual(fixture.calls, [
        ['root', type, is4k],
        'favorite-verify',
        ['series', is4k ? 'four-k-root' : 'hd-root', 42],
      ]);
      assert.equal(response.body.saved, false);
    }
  }
  const plex = buildRoute({ withOpenApi: true });
  const response = await request(plex.app).get(
    '/api/v1/tv/42/media-server-saved-item?is4k=true'
  );
  assert.equal(response.status, 200);
  assert.deepEqual(plex.calls, ['verify']);
});

test('Installed OpenAPI saved-route validation still rejects malformed/extra queries and POST queries', async () => {
  const fixture = buildRoute({ withOpenApi: true });
  for (const query of [
    'is4k=1',
    'is4k=0',
    'is4k=',
    'is4k=TRUE',
    'is4k=true&is4k=false',
    'is4k[]=true',
    'is4k[flag]=true',
    'itemId=81',
    'userId=8',
    'is4k=false&extra=false',
  ]) {
    const response = await request(fixture.app).get(
      `/api/v1/tv/42/media-server-saved-item?${query}`
    );
    assert.equal(response.status, 400, query);
  }
  for (const query of ['is4k=true', 'is4k=false', 'extra=false']) {
    const response = await request(fixture.app)
      .post(`/api/v1/tv/42/media-server-saved-item?${query}`)
      .send({ saved: true });
    assert.equal(response.status, 400, query);
  }
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.admissions, []);
  assert.deepEqual(fixture.logs, []);
});

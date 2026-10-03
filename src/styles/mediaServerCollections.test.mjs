import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(path.resolve('package.json'));
const ts = require('typescript');
const express = require('express');
const request = require('supertest');
const root = process.env.COLLECTION_TEST_SOURCE_ROOT ?? '.';
const compile = (file, dependencies) => {
  const output = ts.transpileModule(
    fs.readFileSync(path.resolve(root, file), 'utf8'),
    {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }
  ).outputText;
  const compiledModule = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    (id) => {
      assert.ok(id in dependencies, 'Unexpected dependency: ' + id);
      return dependencies[id];
    },
    compiledModule,
    compiledModule.exports
  );
  return compiledModule.exports;
};
const types = { PLEX: 1, JELLYFIN: 2, EMBY: 3, NOT_CONFIGURED: 4 };
const guid = '11111111111141118111111111111111';
const roots = {
  1: { hd: '123', '4k': '456' },
  2: { hd: guid, '4k': '22222222222242228222222222222222' },
  3: { hd: '123', '4k': '456' },
};
class Unauthorized extends Error {}
class NativeAuthority extends Error {}
const fixture = ({
  type = 1,
  user,
  authenticated = true,
  authorized = true,
  providerFailure,
  actorMismatch = false,
  qualityRoots = roots[type],
  mediaOverride,
  deny = false,
  changeServer = false,
  unlinkDuringLookup = false,
  withOpenApi = false,
} = {}) => {
  const calls = [];
  const queries = [];
  const actor = user ?? {
    id: 7,
    plexId: 9,
    plexToken: 'current-plex-token',
    jellyfinUserId: guid,
    jellyfinAuthToken: 'current-native-token',
  };
  const settings = {
    main: { mediaServerType: type },
    plex: { ip: 'configured-plex', port: 32400, machineId: 'our-server' },
    jellyfin: { ip: 'configured-native', port: 8096, serverId: 'our-server' },
  };
  let currentActor = actor;
  const result = () => ({
    serverType: type,
    available: !deny,
    ...(deny ? { reason: 'not-authorized' } : {}),
    collections: deny
      ? []
      : [{ id: type === 2 ? guid : '81', name: 'Watch Next', member: false }],
  });
  const provider =
    (kind, writing) =>
    async (...args) => {
      calls.push({ kind, writing, args });
      if (providerFailure) throw providerFailure;
      const value = result();
      if (writing && !deny) value.collections[0].member = args[2];
      return value;
    };
  const providers = {
    '@server/api/jellyfinEmbySavedItems': {
      getJellyfinEmbySeriesCollections: provider('native', false),
      setJellyfinEmbySeriesCollectionMembership: provider('native', true),
    },
    '@server/api/plexCollections': {
      getPlexSeriesCollections: provider('plex', false),
      setPlexSeriesCollectionMembership: provider('plex', true),
      PlexCollectionAuthorityError: NativeAuthority,
    },
    '@server/constants/server': { MediaServerType: types },
    '@server/lib/settings': { getSettings: () => settings },
  };
  const dispatcher = compile('server/api/mediaServerCollections.ts', providers);
  const withAuthority =
    (writing) => async (actorId, targetId, permissions, callback, options) => {
      calls.push({ lock: writing ? 'mutation' : 'read' });
      assert.equal(actorId, 7);
      assert.equal(targetId, 7);
      assert.deepEqual(permissions, []);
      assert.deepEqual(options, { includeMediaServerCredentials: true });
      if (!authorized) throw new Unauthorized();
      return callback(
        actorMismatch ? { ...currentActor, id: 8 } : currentActor
      );
    };
  const routes = compile('server/routes/tvCollections.ts', {
    ...providers,
    '@server/api/mediaServerCollections': dispatcher,
    '@server/constants/media': { MediaType: { TV: 'tv' } },
    '@server/datasource': {
      getRepository: () => ({
        findOne: async (query) => {
          assert.deepEqual(query.where, { tmdbId: 42, mediaType: 'tv' });
          calls.push({ lookup: true });
          if (changeServer) settings.plex.ip = 'different-plex';
          if (unlinkDuringLookup) currentActor = { id: actor.id };
          return mediaOverride === undefined
            ? { tmdbId: 42, mediaType: 'tv' }
            : mediaOverride;
        },
      }),
    },
    '@server/entity/Media': { default: class {}, __esModule: true },
    '@server/lib/playbackMediaRoot': {
      getPlaybackMediaRootId: (_media, serverType, is4k) => {
        calls.push({ root: serverType, is4k });
        return qualityRoots?.[is4k ? '4k' : 'hd'];
      },
    },
    '@server/lib/userSecurityMutation': {
      runUserSecurityReadWithActor: withAuthority(false),
      runUserSecurityMutationWithActor: withAuthority(true),
      UserMutationActorUnauthorizedError: Unauthorized,
    },
    '@server/utils/routeId': {
      parsePositiveRouteId: (value, maximum) =>
        typeof value === 'string' &&
        /^\d+$/.test(value) &&
        Number(value) > 0 &&
        Number.isSafeInteger(Number(value)) &&
        Number(value) <= maximum
          ? Number(value)
          : undefined,
    },
    '@server/utils/security': { getRateLimitKey: () => 'test' },
    express,
    'express-rate-limit': {
      default: () => (_req, _res, next) => next(),
      __esModule: true,
    },
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
  app.use((req, _res, next) => {
    // Stale incoming credentials must never authorize a native operation.
    if (authenticated)
      req.user = {
        id: 7,
        plexToken: 'stale-owner-token',
        jellyfinAuthToken: 'stale-owner-token',
      };
    next();
  });
  if (withOpenApi) app.use('/api/v1/tv', routes);
  else app.use(routes);
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(error.status || 500).json({ invalid: true });
  });
  return { app, calls, dispatcher, actor, queries };
};

for (const type of [1, 2, 3]) {
  test(`Collections provider ${type} reads use current own actor and exact selected Series root`, async () => {
    const f = fixture({ type });
    const response = await request(f.app).get(
      '/42/media-server-collections?is4k=true'
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.available, true);
    assert.equal(f.calls[0].lock, 'read');
    assert.deepEqual(
      f.calls.find((call) => call.root),
      { root: type, is4k: true }
    );
    const action = f.calls.find((call) => call.kind);
    assert.equal(action.kind, type === 1 ? 'plex' : 'native');
    assert.equal(action.writing, false);
    assert.equal(action.args[0].itemId, roots[type]['4k']);
    assert.equal(action.args[0].tmdbId, 42);
    assert.equal(action.args[0].user.plexToken, f.actor.plexToken);
    assert.equal(
      action.args[0].user.jellyfinAuthToken,
      f.actor.jellyfinAuthToken
    );
  });
  test(`Collections provider ${type} mutations use native membership only and own mutation lock`, async () => {
    const f = fixture({ type });
    const id = type === 2 ? guid : '81';
    const response = await request(f.app)
      .post(`/42/media-server-collections/${id}`)
      .send({ member: true, is4k: false });
    assert.equal(response.status, 200);
    assert.equal(response.body.collections[0].member, true);
    assert.equal(f.calls[0].lock, 'mutation');
    const action = f.calls.find((call) => call.kind);
    assert.equal(action.writing, true);
    assert.deepEqual(action.args.slice(1), [id, true]);
    assert.equal(action.args[0].itemId, roots[type].hd);
  });
}

test('Installed OpenAPI middleware preserves false/default and true quality through Collections GET', async () => {
  for (const type of [1, 2, 3]) {
    const f = fixture({ type, withOpenApi: true });
    for (const [query, is4k] of [
      ['', false],
      ['?is4k=false', false],
      ['?is4k=true', true],
    ]) {
      f.calls.length = 0;
      const response = await request(f.app).get(
        `/api/v1/tv/42/media-server-collections${query}`
      );
      assert.equal(response.status, 200);
      assert.deepEqual(f.queries.at(-1), {
        value: is4k,
        valueType: 'boolean',
      });
      assert.deepEqual(
        f.calls.find((call) => call.root),
        { root: type, is4k }
      );
      const native = f.calls.find((call) => call.kind);
      assert.equal(native.writing, false);
      assert.equal(native.args[0].is4k, is4k);
      assert.equal(native.args[0].itemId, roots[type][is4k ? '4k' : 'hd']);
    }
  }
});

test('Installed OpenAPI Collections validation still rejects malformed/extra queries and POST queries', async () => {
  const f = fixture({ withOpenApi: true });
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
    const response = await request(f.app).get(
      `/api/v1/tv/42/media-server-collections?${query}`
    );
    assert.equal(response.status, 400, query);
  }
  for (const query of ['is4k=true', 'is4k=false', 'extra=false']) {
    const response = await request(f.app)
      .post(`/api/v1/tv/42/media-server-collections/81?${query}`)
      .send({ member: true });
    assert.equal(response.status, 400, query);
  }
  assert.deepEqual(f.calls, []);
});
test('Collections reject malformed route IDs, collection IDs, query values and account overrides before native access', async () => {
  const f = fixture();
  for (const id of ['0', '-1', '1e2', '42x', '1000000001'])
    assert.equal(
      (await request(f.app).get(`/${id}/media-server-collections`)).status,
      400
    );
  for (const query of [
    'is4k=1',
    'is4k=',
    'is4k=true&is4k=false',
    'is4k[flag]=true',
    'userId=8',
    'token=admin',
    'itemId=88',
  ])
    assert.equal(
      (await request(f.app).get(`/42/media-server-collections?${query}`))
        .status,
      400
    );
  for (const id of ['0', 'abc', '81junk', guid])
    assert.equal(
      (
        await request(f.app)
          .post(`/42/media-server-collections/${id}`)
          .send({ member: true })
      ).status,
      400
    );
  for (const body of [
    {},
    { member: 'true' },
    { member: true, is4k: 'true' },
    { member: true, is4k: null },
    { member: true, userId: 8 },
    { member: true, token: 'admin' },
    { member: true, itemId: '88' },
    [],
  ])
    assert.equal(
      (await request(f.app).post('/42/media-server-collections/81').send(body))
        .status,
      400
    );
  assert.equal(
    (
      await request(f.app)
        .post('/42/media-server-collections/81?is4k=true')
        .send({ member: true })
    ).status,
    400
  );
  assert.deepEqual(f.calls, []);
});
test('Collections reject GET bodies rather than accepting hidden account authority', async () => {
  const f = fixture();
  assert.equal(
    (
      await request(f.app)
        .get('/42/media-server-collections')
        .send({ token: 'admin' })
    ).status,
    400
  );
  assert.deepEqual(f.calls, []);
});
test('Collections require authenticated current account authority for reads and writes', async () => {
  const missing = fixture({ authenticated: false });
  assert.equal(
    (await request(missing.app).get('/42/media-server-collections')).status,
    401
  );
  assert.deepEqual(missing.calls, []);
  for (const options of [{ authorized: false }, { actorMismatch: true }]) {
    const f = fixture(options);
    assert.equal(
      (await request(f.app).get('/42/media-server-collections')).status,
      403
    );
    assert.equal(
      (
        await request(f.app)
          .post('/42/media-server-collections/81')
          .send({ member: true })
      ).status,
      403
    );
    assert.equal(
      f.calls.some((call) => call.kind),
      false
    );
  }
});
test('Account unlink observed under authority prevents stale session credentials from reaching any provider', async () => {
  for (const type of [1, 2, 3]) {
    const f = fixture({ type, user: { id: 7 } });
    const read = await request(f.app).get('/42/media-server-collections');
    assert.equal(read.status, 200);
    assert.equal(read.body.reason, 'account-not-linked');
    assert.equal(
      (
        await request(f.app)
          .post(`/42/media-server-collections/${type === 2 ? guid : '81'}`)
          .send({ member: true })
      ).status,
      409
    );
    assert.equal(
      f.calls.some((call) => call.kind || call.lookup),
      false
    );
  }
});
test('Missing selected quality never borrows a different Series root', async () => {
  const f = fixture({ qualityRoots: { hd: '123' } });
  const response = await request(f.app).get(
    '/42/media-server-collections?is4k=true'
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.reason, 'series-not-found');
  assert.equal(
    f.calls.some((call) => call.kind),
    false
  );
});
test('Configured native server changes during identity resolution fail before provider access', async () => {
  const f = fixture({ changeServer: true });
  assert.equal(
    (
      await request(f.app)
        .post('/42/media-server-collections/81')
        .send({ member: true })
    ).status,
    403
  );
  assert.equal(
    f.calls.some((call) => call.kind),
    false
  );
});
test('Account unlink during database resolution is re-admitted and rejected before native dispatch', async () => {
  const f = fixture({ unlinkDuringLookup: true });
  assert.equal(
    (await request(f.app).get('/42/media-server-collections')).status,
    403
  );
  assert.equal(
    f.calls.some((call) => call.kind),
    false
  );
  assert.equal(f.calls.filter((call) => call.lock).length, 2);
});
test('Mismatched or absent database media cannot become trusted collection context', async () => {
  for (const mediaOverride of [
    null,
    { tmdbId: 99, mediaType: 'tv' },
    { tmdbId: 42, mediaType: 'movie' },
  ]) {
    const f = fixture({ mediaOverride });
    const read = await request(f.app).get('/42/media-server-collections');
    assert.equal(read.body.reason, 'series-not-found');
    assert.equal(
      f.calls.some((call) => call.kind),
      false
    );
  }
});
test('Native denied capabilities remain unavailable rather than a collection update success', async () => {
  const f = fixture({ deny: true });
  const response = await request(f.app).get('/42/media-server-collections');
  assert.equal(response.status, 200);
  assert.equal(response.body.available, false);
  assert.equal(
    (
      await request(f.app)
        .post('/42/media-server-collections/81')
        .send({ member: true })
    ).status,
    409
  );
});
test('Native owner authority errors are sanitized forbidden responses', async () => {
  const f = fixture({
    providerFailure: new NativeAuthority('token=do-not-return'),
  });
  const response = await request(f.app)
    .post('/42/media-server-collections/81')
    .send({ member: true });
  assert.equal(response.status, 403);
  assert.equal(JSON.stringify(response.body).includes('do-not-return'), false);
});
test('Provider partial-update or read failure never leaks credentials or produces success', async () => {
  const f = fixture({
    providerFailure: new Error('Authorization token=do-not-return'),
  });
  for (const response of [
    await request(f.app).get('/42/media-server-collections'),
    await request(f.app)
      .post('/42/media-server-collections/81')
      .send({ member: true }),
  ]) {
    assert.equal(response.status, 502);
    assert.equal(
      JSON.stringify(response.body).includes('do-not-return'),
      false
    );
  }
});
test('Dispatcher fails closed unsupported servers, unknown roots and provider-specific collection IDs', async () => {
  const f = fixture({ type: 4 });
  assert.equal(
    (await request(f.app).get('/42/media-server-collections')).body.reason,
    'unsupported-server'
  );
  assert.equal(
    f.calls.some((call) => call.kind),
    false
  );
  const native = fixture({ type: 2 });
  const context = { user: native.actor, tmdbId: 42, itemId: guid, is4k: false };
  assert.equal(
    (
      await native.dispatcher.setMediaServerSeriesCollectionMembership(
        context,
        '81',
        true
      )
    ).reason,
    'not-authorized'
  );
  assert.equal(
    (
      await native.dispatcher.getMediaServerSeriesCollections({
        ...context,
        itemId: '../81',
      })
    ).reason,
    'series-not-found'
  );
  assert.equal(
    native.calls.some((call) => call.kind),
    false
  );
});

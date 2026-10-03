import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(path.resolve('package.json'));
const ts = require('typescript');
const root = process.env.SAVED_ITEM_TEST_SOURCE_ROOT ?? '.';
const source = fs.readFileSync(
  path.resolve(root, 'server/api/plexCollections.ts'),
  'utf8'
);
const settings = { plex: { machineId: 'own-server' } };
let accountId = 7;
let devices = [
  { owned: true, provides: ['server'], clientIdentifier: 'own-server' },
];
class MockPlexAPI {
  constructor(options) {
    this.options = options;
    this.calls = [];
    this.responses = [];
  }
  async getStatus() {
    return { MediaContainer: { machineIdentifier: 'own-server' } };
  }
  async request(method, endpoint, body, config) {
    this.calls.push({ method, endpoint, body, config });
    assert.ok(this.responses.length, 'All provider requests must be mocked');
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return { data: next };
  }
}
class MockSavedAPI {
  async verifyAccount(id) {
    assert.equal(id, accountId);
  }
  async getOwnedServerIds() {
    return devices
      .filter((device) => device.owned && device.provides.includes('server'))
      .map((device) => device.clientIdentifier);
  }
}
const moduleValue = { exports: {} };
const javascript = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText;
new Function('require', 'module', 'exports', javascript)(
  (id) => {
    if (id.endsWith('/plexapi'))
      return { default: MockPlexAPI, __esModule: true };
    if (id.endsWith('/mediaServerSavedItem'))
      return {
        PlexSavedItemAPI: MockSavedAPI,
      };
    if (id.endsWith('/constants/server'))
      return { MediaServerType: { PLEX: 1 } };
    if (id.endsWith('/lib/settings')) return { getSettings: () => settings };
    if (id.endsWith('/utils/concurrency'))
      return {
        mapWithConcurrency: async (items, limit, callback) => {
          assert.equal(limit, 5);
          return Promise.all(items.map(callback));
        },
      };
    throw new Error(`Unexpected dependency ${id}`);
  },
  moduleValue,
  moduleValue.exports
);
const { PlexSeriesCollectionsAPI } = moduleValue.exports;
const context = {
  user: { id: 2, plexId: 7, plexToken: 'current-linked-token' },
  tmdbId: 42,
  itemId: '81',
  is4k: false,
};
const series = {
  ratingKey: '81',
  type: 'show',
  guid: 'plex://show/5d9c08ab391719001f6c8e7b',
  Guid: [{ id: 'tmdb://42' }],
  librarySectionID: 3,
};
const collection = {
  ratingKey: '12',
  type: 'collection',
  subtype: 'show',
  smart: false,
  guid: 'collection://abc-123',
  title: 'Watch Next',
  librarySectionID: 3,
};
const page = (items, extra = {}) => ({
  MediaContainer: { size: items.length, Metadata: items, ...extra },
});
const newAPI = (extra = {}) =>
  new PlexSeriesCollectionsAPI({ ...context, ...extra });

test('Plex Collections are owner-only and never substitute shared credentials', async () => {
  const api = newAPI();
  assert.equal(api.options.plexToken, context.user.plexToken);
  devices = [
    { owned: false, provides: ['server'], clientIdentifier: 'own-server' },
  ];
  assert.equal((await api.read()).reason, 'not-authorized');
  await assert.rejects(api.setMembership('12', true));
  assert.equal(api.calls.length, 0);
  devices = [
    { owned: true, provides: ['server'], clientIdentifier: 'another-server' },
  ];
  assert.equal((await api.read()).reason, 'not-authorized');
  devices = [
    { owned: true, provides: ['server'], clientIdentifier: 'own-server' },
  ];
  accountId = 8;
  await assert.rejects(api.read());
  accountId = 7;
  assert.equal(
    (await newAPI({ user: { id: 2 } }).read()).reason,
    'account-not-linked'
  );
  assert.equal(api.calls.length, 0);
});

test('Plex lists existing manual Series collections with confirmed membership', async () => {
  const api = newAPI();
  api.responses.push(
    page([series]),
    page(
      [
        collection,
        { ...collection, ratingKey: '13', smart: true },
        { ...collection, ratingKey: '14', subtype: 'movie' },
      ],
      { totalSize: 3 }
    ),
    page([series], { totalSize: 1 })
  );
  assert.deepEqual((await api.read()).collections, [
    { id: '12', name: 'Watch Next', member: true },
  ]);
  assert.equal(api.calls[1].endpoint, '/library/sections/3/collections');
  assert.ok(api.calls.every((call) => call.method === 'GET'));
});

test('Section-scoped catalog omissions stay compatible without weakening mutation identity', async () => {
  const sectionScoped = { ...collection };
  delete sectionScoped.librarySectionID;
  delete sectionScoped.smart;
  const read = newAPI();
  read.responses.push(page([series]), page([sectionScoped]), page([series]));
  assert.deepEqual((await read.read()).collections, [
    { id: '12', name: 'Watch Next', member: true },
  ]);

  const write = newAPI();
  write.responses.push(
    page([series]),
    page([sectionScoped]),
    page([]),
    page([sectionScoped])
  );
  await assert.rejects(write.setMembership('12', true));
  assert.ok(write.calls.every((call) => call.method === 'GET'));

  const detailOmittedSmart = { ...collection };
  delete detailOmittedSmart.smart;
  const compatibleWrite = newAPI();
  compatibleWrite.responses.push(
    page([series]),
    page([sectionScoped]),
    page([]),
    page([detailOmittedSmart]),
    {},
    page([series]),
    page([series]),
    page([sectionScoped]),
    page([series])
  );
  assert.equal(
    (await compatibleWrite.setMembership('12', true)).collections[0].member,
    true
  );
  assert.deepEqual(
    compatibleWrite.calls
      .filter((call) => call.method !== 'GET')
      .map(({ method, endpoint }) => ({ method, endpoint })),
    [{ method: 'PUT', endpoint: '/library/collections/12/items' }]
  );
});

test('A legitimate empty collection library is distinct from malformed/incomplete data', async () => {
  const api = newAPI();
  api.responses.push(page([series]), {
    MediaContainer: { size: 0, totalSize: 0 },
  });
  assert.deepEqual((await api.read()).collections, []);
  for (const invalid of [
    { MediaContainer: {} },
    page([], { totalSize: 1 }),
    page([], { size: 1 }),
    page([], { offset: 100 }),
  ]) {
    const broken = newAPI();
    broken.responses.push(page([series]), invalid);
    await assert.rejects(broken.read());
  }
});
test('PMS Collections accept a legacy native Series GUID only with exact TMDB identity', async () => {
  const api = newAPI();
  const legacySeries = {
    ...series,
    guid: 'com.plexapp.agents.thetvdb://123?lang=en',
  };
  api.responses.push(
    page([legacySeries]),
    page([collection]),
    page([legacySeries])
  );
  assert.equal((await api.read()).collections[0].member, true);
  const wrong = newAPI();
  wrong.responses.push(
    page([{ ...legacySeries, Guid: [{ id: 'tmdb://43' }] }])
  );
  await assert.rejects(wrong.read());
});

test('Collection identities, library association and exact Series TMDB mapping fail closed', async () => {
  for (const wrong of [
    { ...series, Guid: [{ id: 'tmdb://43' }] },
    { ...series, type: 'episode' },
    { ...series, ratingKey: '99' },
  ]) {
    const api = newAPI();
    api.responses.push(page([wrong]));
    await assert.rejects(api.read());
    assert.equal(api.calls.length, 1);
  }
  for (const wrong of [
    { ...collection, librarySectionID: 4 },
    { ...collection, guid: 'plex://show/not-a-collection' },
    { ...collection, ratingKey: '../12' },
  ]) {
    const api = newAPI();
    api.responses.push(page([series]), page([wrong]));
    await assert.rejects(api.read());
    assert.ok(api.calls.every((call) => call.method === 'GET'));
  }
});

test('Collection enumeration is complete, bounded and rejects duplicate members', async () => {
  const over = newAPI();
  over.responses.push(page([series]), page([], { totalSize: 501 }));
  assert.equal((await over.read()).reason, 'collection-limit');
  const duplicate = newAPI();
  duplicate.responses.push(
    page([series]),
    page([collection]),
    page([series, series])
  );
  await assert.rejects(duplicate.read());
  const mismatched = newAPI();
  mismatched.responses.push(
    page([series]),
    page([collection]),
    page([{ ...series, guid: 'plex://show/aaaaaaaaaaaaaaaaaaaaaaaa' }])
  );
  await assert.rejects(mismatched.read());
});

test('Add uses the existing collection URI and confirms state without creating a collection', async () => {
  const api = newAPI();
  api.responses.push(
    page([series]),
    page([collection]),
    page([]),
    page([collection]),
    {},
    page([series]),
    page([series]),
    page([collection]),
    page([series])
  );
  const result = await api.setMembership('12', true);
  assert.equal(result.collections[0].member, true);
  const mutations = api.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(mutations, [
    {
      method: 'PUT',
      endpoint: '/library/collections/12/items',
      body: null,
      config: {
        params: {
          uri: 'server://own-server/com.plexapp.plugins.library/library/metadata/81',
        },
      },
    },
  ]);
});

test('Remove uses canonical item-only DELETE and never deletes the collection itself', async () => {
  const api = newAPI();
  api.responses.push(
    page([series]),
    page([collection]),
    page([series]),
    page([collection]),
    {},
    page([]),
    page([series]),
    page([collection]),
    page([])
  );
  assert.equal(
    (await api.setMembership('12', false)).collections[0].member,
    false
  );
  assert.deepEqual(
    api.calls
      .filter((call) => call.method !== 'GET')
      .map(({ method, endpoint }) => ({ method, endpoint })),
    [{ method: 'DELETE', endpoint: '/library/collections/12/items/81' }]
  );
});

test('Idempotent membership avoids writes; stale identity and unconfirmed writes cannot report success', async () => {
  const api = newAPI();
  api.responses.push(
    page([series]),
    page([collection]),
    page([series]),
    page([series]),
    page([collection]),
    page([series])
  );
  await api.setMembership('12', true);
  assert.ok(api.calls.every((call) => call.method === 'GET'));
  const stale = newAPI();
  stale.responses.push(
    page([series]),
    page([collection]),
    page([]),
    page([{ ...collection, guid: 'collection://replaced' }])
  );
  await assert.rejects(stale.setMembership('12', true));
  assert.ok(stale.calls.every((call) => call.method === 'GET'));
  const failed = newAPI();
  failed.responses.push(
    page([series]),
    page([collection]),
    page([]),
    page([collection]),
    {},
    page([])
  );
  await assert.rejects(failed.setMembership('12', true));
  const invalid = newAPI();
  await assert.rejects(invalid.setMembership('../12', true));
  assert.equal(invalid.calls.length, 0);
});

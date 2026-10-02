import { SuwayomiError } from '@server/api/suwayomi/errors';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  buildSuwayomiAuth,
  createSuwayomiClient,
  getSuwayomiClient,
  invalidateSuwayomiClients,
} from '@server/lib/suwayomi/clientFactory';
import {
  graphqlData,
  startFakeSuwayomi,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const USERNAME = 'fake-user';
const PASSWORD = randomUUID();
const SOURCES = graphqlData({
  sources: {
    nodes: [
      {
        id: '4000000000000000001',
        name: 'Source A',
        displayName: 'Source A (EN)',
        lang: 'en',
        contentWarning: 'SAFE',
        supportsLatest: true,
        extension: { hasUpdate: false, isObsolete: false },
      },
    ],
  },
});
const servers: FakeSuwayomi[] = [];

const start = async () => {
  const server = await startFakeSuwayomi({
    mode: 'UI_LOGIN',
    username: USERNAME,
    password: PASSWORD,
  });
  server.onOperation('Sources', SOURCES);
  servers.push(server);
  return server;
};

const instance = (
  overrides: Partial<SuwayomiSettings> = {}
): SuwayomiSettings => ({
  id: 1,
  name: 'Suwayomi',
  hostname: 'suwayomi.invalid',
  port: 4567,
  useSsl: false,
  baseUrl: '',
  isDefault: true,
  authMode: 'UI_LOGIN',
  username: USERNAME,
  password: PASSWORD,
  sourceAllowlist: [],
  preferredLanguages: [],
  scanlatorPreference: [],
  requireCbz: true,
  ...overrides,
});

const instanceFor = (
  server: FakeSuwayomi,
  overrides: Partial<SuwayomiSettings> = {}
): SuwayomiSettings => {
  const url = new URL(server.url);
  return instance({
    hostname: url.hostname,
    port: Number(url.port),
    ...overrides,
  });
};

beforeEach(() => {
  invalidateSuwayomiClients();
  getSettings().suwayomi = [];
});

afterEach(async () => {
  mock.restoreAll();
  invalidateSuwayomiClients();
  getSettings().suwayomi = [];
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('buildSuwayomiAuth', () => {
  it('sends credentials only for the stored mode', () => {
    assert.deepEqual(
      buildSuwayomiAuth({
        authMode: 'NONE',
        username: USERNAME,
        password: PASSWORD,
      }),
      { mode: 'NONE' }
    );
    for (const authMode of ['UI_LOGIN', 'BASIC_AUTH'] as const) {
      assert.deepEqual(
        buildSuwayomiAuth({ authMode, username: USERNAME, password: PASSWORD }),
        { mode: authMode, username: USERNAME, password: PASSWORD }
      );
    }
  });

  it('refuses a signing-in mode without credentials and unknown modes', () => {
    assert.throws(
      () =>
        buildSuwayomiAuth({ authMode: 'UI_LOGIN', username: '', password: '' }),
      (error: unknown) =>
        error instanceof SuwayomiError &&
        error.code === 'INVALID_ARGUMENT' &&
        error.operation === 'configure'
    );
    assert.throws(
      () =>
        buildSuwayomiAuth({
          authMode: 'SIMPLE_LOGIN' as never,
          username: USERNAME,
          password: PASSWORD,
        }),
      (error: unknown) =>
        error instanceof SuwayomiError &&
        error.code === 'AUTH_MODE_UNSUPPORTED' &&
        error.operation === 'configure'
    );
  });
});

describe('getSuwayomiClient', () => {
  it('returns undefined when no matching instance is configured', () => {
    assert.equal(getSuwayomiClient(), undefined);
    assert.equal(getSuwayomiClient(1), undefined);
    getSettings().suwayomi = [instance({ id: 3 })];
    assert.equal(getSuwayomiClient(1), undefined);
  });

  it('picks the default instance, else the first, when no ID is given', () => {
    getSettings().suwayomi = [
      instance({ id: 1, isDefault: false, hostname: 'first.invalid' }),
      instance({ id: 2, isDefault: true, hostname: 'default.invalid' }),
    ];
    assert.equal(getSuwayomiClient(), getSuwayomiClient(2));
    assert.notEqual(getSuwayomiClient(), getSuwayomiClient(1));

    getSettings().suwayomi = [
      instance({ id: 1, isDefault: false, hostname: 'first.invalid' }),
      instance({ id: 2, isDefault: false, hostname: 'second.invalid' }),
    ];
    assert.equal(getSuwayomiClient(), getSuwayomiClient(1));
  });

  it('reuses the client while the address and credentials are unchanged', () => {
    getSettings().suwayomi = [instance()];
    const client = getSuwayomiClient(1);
    assert.ok(client);
    assert.equal(getSuwayomiClient(1), client);

    getSettings().suwayomi = [
      instance({
        name: 'Renamed',
        sourceAllowlist: ['4000000000000000001'],
        preferredLanguages: ['en'],
        scanlatorPreference: ['Group A'],
        requireCbz: false,
      }),
    ];
    assert.equal(getSuwayomiClient(1), client);
  });

  it('builds a new client when the address or credentials change', () => {
    const changes: Partial<SuwayomiSettings>[] = [
      { hostname: 'other.invalid' },
      { port: 4568 },
      { useSsl: true },
      { baseUrl: '/suwayomi' },
      { authMode: 'BASIC_AUTH' },
      { username: 'other-user' },
      { password: randomUUID() },
    ];
    for (const change of changes) {
      getSettings().suwayomi = [instance()];
      const client = getSuwayomiClient(1);
      getSettings().suwayomi = [instance(change)];
      const changed = getSuwayomiClient(1);
      assert.ok(changed);
      assert.notEqual(changed, client, Object.keys(change)[0]);
      assert.equal(getSuwayomiClient(1), changed);
    }
  });

  it('builds new clients after they are invalidated', () => {
    getSettings().suwayomi = [
      instance({ id: 1 }),
      instance({ id: 2, isDefault: false }),
    ];
    const first = getSuwayomiClient(1);
    const second = getSuwayomiClient(2);

    invalidateSuwayomiClients(1);
    const firstAgain = getSuwayomiClient(1);
    assert.notEqual(firstAgain, first);
    assert.equal(getSuwayomiClient(2), second);

    invalidateSuwayomiClients();
    assert.notEqual(getSuwayomiClient(1), firstAgain);
    assert.notEqual(getSuwayomiClient(2), second);
  });

  it('never caches clients built for a connection test', () => {
    getSettings().suwayomi = [instance()];
    const cached = getSuwayomiClient(1);
    const first = createSuwayomiClient(instance());
    const second = createSuwayomiClient(instance());
    assert.notEqual(first, second);
    assert.notEqual(first, cached);
    assert.equal(getSuwayomiClient(1), cached);
  });

  it('never sends one server’s tokens to another server', async () => {
    const serverA = await start();
    const serverB = await start();
    getSettings().suwayomi = [instanceFor(serverA)];
    const clientA = getSuwayomiClient(1);
    assert.ok(clientA);
    await clientA.getSources();

    getSettings().suwayomi = [instanceFor(serverB)];
    const clientB = getSuwayomiClient(1);
    assert.ok(clientB);
    assert.notEqual(clientB, clientA);
    await clientB.getSources();

    assert.equal(serverA.logins, 1);
    assert.equal(serverB.logins, 1);
    const tokensA = serverA.issuedTokens();
    assert.ok(tokensA.length > 0);
    for (const request of serverB.requests) {
      const sent = `${request.headers.authorization ?? ''} ${JSON.stringify(
        request.variables
      )}`;
      for (const token of tokensA) {
        assert.ok(!sent.includes(token));
      }
    }
  });

  it('signs in again instead of reusing tokens after the password changes', async () => {
    const server = await start();
    getSettings().suwayomi = [instanceFor(server)];
    await getSuwayomiClient(1)?.getSources();
    const issued = server.issuedTokens();
    const before = server.requests.length;

    getSettings().suwayomi = [instanceFor(server, { password: randomUUID() })];
    await assert.rejects(
      () => getSuwayomiClient(1)?.getSources() ?? Promise.resolve(),
      (error: unknown) =>
        error instanceof SuwayomiError && error.code === 'AUTH_FAILED'
    );

    const after = server.requests.slice(before);
    assert.deepEqual(
      after.map(({ operationName }) => operationName),
      ['Login']
    );
    for (const token of issued) {
      assert.ok(!(after[0].headers.authorization ?? '').includes(token));
    }
  });
});

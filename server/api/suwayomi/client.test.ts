import SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import { ROOT_FIELDS } from '@server/api/suwayomi/operations';
import type { SuwayomiAPIOptions } from '@server/api/suwayomi/types';
import logger from '@server/logger';
import {
  FAKE_VERSION,
  graphqlData,
  graphqlErrors,
  startFakeSuwayomi,
  syntheticFailure,
  type FakeSuwayomi,
  type FakeSuwayomiOptions,
} from '@server/test/fakeSuwayomi';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

const USERNAME = 'fake-user';
const PASSWORD = randomUUID();
const NO_SOURCES = graphqlData({ sources: { nodes: [] } });
const servers: FakeSuwayomi[] = [];

const start = async (options: FakeSuwayomiOptions = {}) => {
  const server = await startFakeSuwayomi({
    username: USERNAME,
    password: PASSWORD,
    ...options,
  });
  servers.push(server);
  return server;
};

const connect = (
  server: FakeSuwayomi,
  overrides: Partial<SuwayomiAPIOptions> = {}
) =>
  new SuwayomiAPI({
    url: server.url,
    auth: { mode: 'UI_LOGIN', username: USERNAME, password: PASSWORD },
    ...overrides,
  });

/** Records every log call, rendered the way a log transport would see it. */
const captureLogs = () => {
  const calls: unknown[][] = [];
  for (const level of ['error', 'warn', 'info', 'debug', 'verbose'] as const) {
    mock.method(logger, level, (...args: unknown[]) => {
      calls.push([level, ...args]);
      return logger;
    });
  }
  return {
    calls,
    text: () => inspect(calls, { depth: 10, breakLength: Infinity }),
  };
};

const fields = (names: readonly string[]) => ({
  fields: names.map((name) => ({ name })),
});

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('SuwayomiAPI configuration', () => {
  it('rejects unsupported modes, unsafe URLs and invalid numbers', () => {
    const url = 'http://127.0.0.1:9/';
    const cases: [Partial<SuwayomiAPIOptions>, string][] = [
      [{ auth: { mode: 'SIMPLE_LOGIN' } as never }, 'AUTH_MODE_UNSUPPORTED'],
      [{ auth: undefined as never }, 'AUTH_MODE_UNSUPPORTED'],
      [
        { auth: { mode: 'UI_LOGIN', username: USERNAME } as never },
        'INVALID_ARGUMENT',
      ],
      [{ url: 'http://user:secret@127.0.0.1:9/' }, 'INVALID_ARGUMENT'],
      [{ url: 'ftp://127.0.0.1/' }, 'INVALID_ARGUMENT'],
      [{ url: 'not a url' }, 'INVALID_ARGUMENT'],
      [{ timeouts: { query: 0 } }, 'INVALID_ARGUMENT'],
      [{ timeouts: { source: 1.5 } }, 'INVALID_ARGUMENT'],
    ];
    for (const [options, code] of cases) {
      assert.throws(
        () => new SuwayomiAPI({ url, auth: { mode: 'NONE' }, ...options }),
        (error: unknown) =>
          error instanceof SuwayomiError &&
          error.code === code &&
          error.operation === 'configure',
        inspect(options)
      );
    }
  });

  it('warns loudly, once per server, when authentication is disabled', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'NONE' });
    connect(server, { auth: { mode: 'NONE' } });
    connect(server, { auth: { mode: 'NONE' } });
    assert.equal(logs.calls.length, 1);
    assert.equal(logs.calls[0][0], 'warn');
    assert.match(String(logs.calls[0][1]), /authentication is disabled/);
    assert.ok(!logs.text().includes(server.origin));
  });

  it('warns that Basic authentication sends credentials on every request', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'BASIC_AUTH' });
    connect(server, {
      auth: { mode: 'BASIC_AUTH', username: USERNAME, password: PASSWORD },
    });
    assert.equal(logs.calls.length, 1);
    assert.match(String(logs.calls[0][1]), /Basic authentication/);
    assert.ok(!logs.text().includes(PASSWORD));
  });

  it('does not warn about UI login', async () => {
    const logs = captureLogs();
    connect(await start());
    assert.equal(logs.calls.length, 0);
  });
});

describe('SuwayomiAPI auth mode detection', () => {
  const basic = {
    auth: { mode: 'BASIC_AUTH', username: USERNAME, password: PASSWORD },
  } as const;

  it('detects UI login and keeps the tokens it obtained', async () => {
    const server = await start();
    server.onOperation('Sources', NO_SOURCES);
    const api = connect(server);
    assert.deepEqual(await api.detectAuthMode(), {
      mode: 'UI_LOGIN',
      supported: true,
      authenticated: true,
      matchesConfigured: true,
      warnings: [],
    });
    await api.getSources();
    assert.equal(server.logins, 1);
  });

  it('detects Basic authentication from its challenge', async () => {
    const server = await start({ mode: 'BASIC_AUTH' });
    assert.deepEqual(await connect(server, basic).detectAuthMode(), {
      mode: 'BASIC_AUTH',
      supported: true,
      authenticated: true,
      matchesConfigured: true,
      warnings: ['BASIC_AUTH_IN_USE'],
    });
    assert.deepEqual(await connect(server).detectAuthMode(), {
      mode: 'BASIC_AUTH',
      supported: true,
      authenticated: false,
      matchesConfigured: false,
      warnings: ['MODE_MISMATCH', 'BASIC_AUTH_IN_USE'],
    });
  });

  it('reports wrong Basic credentials as AUTH_FAILED', async () => {
    const server = await start({ mode: 'BASIC_AUTH' });
    const api = connect(server, {
      auth: { mode: 'BASIC_AUTH', username: USERNAME, password: 'wrong' },
    });
    await assert.rejects(api.detectAuthMode(), { code: 'AUTH_FAILED' });
  });

  it('flags a server without authentication', async () => {
    const server = await start({ mode: 'NONE' });
    assert.deepEqual(
      await connect(server, { auth: { mode: 'NONE' } }).detectAuthMode(),
      {
        mode: 'NONE',
        supported: true,
        authenticated: true,
        matchesConfigured: true,
        warnings: ['AUTH_DISABLED'],
      }
    );
  });

  it('rejects simple login, whose API ignores the tokens it issues', async () => {
    const server = await start({ mode: 'SIMPLE_LOGIN' });
    assert.deepEqual(await connect(server).detectAuthMode(), {
      mode: 'SIMPLE_LOGIN',
      supported: false,
      authenticated: false,
      matchesConfigured: false,
      warnings: ['MODE_MISMATCH'],
    });
  });

  it('asks for credentials when the server requires a login', async () => {
    const server = await start();
    assert.deepEqual(
      await connect(server, { auth: { mode: 'NONE' } }).detectAuthMode(),
      {
        mode: 'LOGIN_REQUIRED',
        supported: false,
        authenticated: false,
        matchesConfigured: false,
        warnings: ['MODE_MISMATCH'],
      }
    );
  });

  it('warns when configured credentials are empty', async () => {
    const server = await start({
      mode: 'BASIC_AUTH',
      username: '',
      password: '',
    });
    const detection = await connect(server, {
      auth: { mode: 'BASIC_AUTH', username: '', password: '' },
    }).detectAuthMode();
    assert.deepEqual(detection.warnings, [
      'EMPTY_CREDENTIALS',
      'BASIC_AUTH_IN_USE',
    ]);
  });

  it('classifies a wrong password without logging it or Suwayomi text', async () => {
    const logs = captureLogs();
    const server = await start();
    const wrongPassword = randomUUID();
    const api = connect(server, {
      auth: { mode: 'UI_LOGIN', username: USERNAME, password: wrongPassword },
    });
    await assert.rejects(api.detectAuthMode(), (error: unknown) => {
      assert.ok(error instanceof SuwayomiError);
      assert.equal(error.code, 'AUTH_FAILED');
      assert.equal(
        error.message,
        'Suwayomi rejected the configured credentials.'
      );
      return true;
    });
    assert.equal(server.logins, 0);
    const output = logs.text();
    assert.match(output, /AUTH_FAILED/);
    assert.ok(!output.includes(wrongPassword));
    assert.doesNotMatch(output, /Incorrect username/);
  });
});

describe('SuwayomiAPI capabilities and health', () => {
  it('reads capabilities from introspection', async () => {
    const server = await start();
    server.onOperation(
      'Capabilities',
      graphqlData({
        aboutServer: {
          name: 'Suwayomi-Server',
          version: FAKE_VERSION,
          buildType: 'Stable',
        },
        __schema: {
          queryType: fields(ROOT_FIELDS.query),
          mutationType: fields(ROOT_FIELDS.mutation),
        },
        mangaType: fields(['id']),
        chapterType: fields(['id', 'user']),
      })
    );
    const capabilities = await connect(server).getCapabilities();
    assert.equal(capabilities.supported, true);
    assert.equal(capabilities.partialFetchResults, true);
    assert.equal(capabilities.perUserDownloadState, true);
    assert.match(
      server.operations('Capabilities')[0].headers.authorization ?? '',
      /^Bearer /
    );
  });

  it('falls back to the version when introspection is refused', async () => {
    const server = await start();
    server.onOperation('Capabilities', graphqlErrors([syntheticFailure()]));
    const capabilities = await connect(server).getCapabilities();
    assert.equal(capabilities.version, FAKE_VERSION);
    assert.equal(capabilities.supported, true);
    assert.deepEqual(capabilities.warnings, ['INTROSPECTION_UNAVAILABLE']);
  });

  it('does not fall back when authentication fails', async () => {
    const server = await start();
    server.onOperation('Capabilities', graphqlErrors(['Unauthorized']));
    await assert.rejects(connect(server).getCapabilities(), {
      code: 'AUTH_REQUIRED',
    });
    assert.equal(server.operations('Probe').length, 0);
  });

  it('reads health and installed sources', async () => {
    const server = await start();
    server.onOperation(
      'Health',
      graphqlData({
        aboutServer: { version: FAKE_VERSION },
        settings: { downloadAsCbz: true, autoDownloadNewChapters: false },
        downloadStatus: { state: 'STARTED', queue: [{ state: 'QUEUED' }] },
        sources: { totalCount: 3 },
      })
    );
    server.onOperation(
      'Sources',
      graphqlData({
        sources: {
          nodes: [
            { id: '0', name: 'Local source' },
            { id: '4000000000000000001', name: 'Fake Source', lang: 'en' },
          ],
        },
      })
    );
    const api = connect(server);
    const health = await api.getHealth();
    assert.equal(health.downloaderState, 'STARTED');
    assert.equal(health.sourceCount, 2);
    assert.deepEqual(health.warnings, []);
    const sources = await api.getSources();
    assert.deepEqual(
      sources.map((source) => source.id),
      ['4000000000000000001']
    );
  });
});

describe('SuwayomiAPI error handling', () => {
  it('turns HTTP 200 errors into a code and drops the upstream text', async () => {
    const logs = captureLogs();
    const server = await start();
    server.onOperation(
      'Sources',
      graphqlErrors([syntheticFailure(), 'second'])
    );
    const error = await connect(server)
      .getSources()
      .then(
        () => assert.fail('expected a failure'),
        (failure: unknown) => failure
      );
    assert.ok(error instanceof SuwayomiError);
    assert.deepEqual(error.toJSON(), {
      name: 'SuwayomiError',
      code: 'UPSTREAM_ERROR',
      message: 'Suwayomi reported an error.',
      operation: 'Sources',
      httpStatus: 200,
      errorCount: 2,
      retryable: true,
    });
    const rendered = `${inspect(error)} ${logs.text()}`;
    assert.doesNotMatch(rendered, /FakeFailure|Fake\.kt|\r/);
    for (const token of server.issuedTokens()) {
      assert.ok(!rendered.includes(token));
    }
    assert.ok(!rendered.includes(PASSWORD));
  });

  it('fails a hung query after its timeout and does not resend it', async () => {
    const server = await start({ mode: 'NONE' });
    server.onOperation('Sources', { hang: true });
    const api = connect(server, {
      auth: { mode: 'NONE' },
      timeouts: { query: 100 },
    });
    const started = Date.now();
    await assert.rejects(api.getSources(), { code: 'TIMEOUT' });
    assert.ok(Date.now() - started < 5_000);
    assert.equal(server.operations('Sources').length, 1);
  });

  it('times out a body that stalls after the headers', async () => {
    const server = await start({ mode: 'NONE' });
    server.onOperation('Sources', {
      chunks: ['{"data":', '{"sources":{"nodes":[]}}}'],
      stallAfterChunks: 1,
    });
    const api = connect(server, {
      auth: { mode: 'NONE' },
      timeouts: { query: 200 },
    });
    await assert.rejects(api.getSources(), { code: 'TIMEOUT' });
    assert.equal(server.operations('Sources').length, 1);
  });

  it('times out a body that trickles in past the deadline', async () => {
    const server = await start({ mode: 'NONE' });
    server.onOperation('Sources', {
      chunks: [...Array(40).fill(' '), '{"data":{"sources":{"nodes":[]}}}'],
      chunkDelayMs: 50,
    });
    const api = connect(server, {
      auth: { mode: 'NONE' },
      timeouts: { query: 300 },
    });
    const started = Date.now();
    await assert.rejects(api.getSources(), { code: 'TIMEOUT' });
    assert.ok(Date.now() - started < 1_500);
  });

  it('reports a connection dropped mid-body as UNREACHABLE', async () => {
    const server = await start({ mode: 'NONE' });
    server.onOperation('Sources', {
      chunks: ['{"data":', '{"sources":{"nodes":[]}}}'],
      chunkDelayMs: 50,
      dropAfterChunks: 1,
    });
    await assert.rejects(
      connect(server, { auth: { mode: 'NONE' } }).getSources(),
      { code: 'UNREACHABLE' }
    );
  });

  it('reports a cancelled call as ABORTED', async () => {
    const server = await start({ mode: 'NONE' });
    server.onOperation('Sources', { hang: true });
    const controller = new AbortController();
    const pending = connect(server, { auth: { mode: 'NONE' } }).getSources({
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, { code: 'ABORTED' });
  });

  it('reports a connection failure as UNREACHABLE', async () => {
    const server = await start({ mode: 'NONE' });
    await server.close();
    await assert.rejects(
      connect(server, { auth: { mode: 'NONE' } }).getSources(),
      { code: 'UNREACHABLE' }
    );
  });

  it('refuses a cross-origin redirect without contacting the other origin', async () => {
    const other = await start({ mode: 'NONE' });
    const server = await start();
    server.onOperation('Sources', {
      status: 307,
      headers: { Location: `${other.url}api/graphql` },
    });
    await assert.rejects(connect(server).getSources(), {
      code: 'REQUEST_REFUSED',
    });
    assert.equal(other.requests.length, 0);
  });

  it('serves a Suwayomi below a sub-path', async () => {
    const server = await start({ basePath: '/manga/' });
    server.onOperation('Sources', NO_SOURCES);
    assert.deepEqual(await connect(server).getSources(), []);
    assert.ok(
      server.requests.every((request) => request.url === '/manga/api/graphql')
    );
  });
});

describe('SuwayomiAPI UI login tokens', () => {
  it('sends the access token only in the Authorization header', async () => {
    const server = await start();
    server.onOperation('Sources', NO_SOURCES);
    const api = connect(server);
    await api.getSources();
    await api.getSources();
    assert.equal(server.logins, 1);
    assert.equal(
      server.operations('Login')[0].headers.authorization,
      undefined
    );
    for (const request of server.requests) {
      assert.equal(request.headers.cookie, undefined);
      assert.doesNotMatch(request.url, /token/i);
    }
    const sent = server
      .operations('Sources')
      .map((request) => request.headers.authorization);
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1]);
    assert.match(sent[0] ?? '', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('refreshes when Suwayomi answers Unauthorized with HTTP 200', async () => {
    const server = await start();
    server.onOperation('Sources', NO_SOURCES);
    const api = connect(server);
    await api.getSources();
    server.expireAccessTokens();
    await api.getSources();
    assert.equal(server.logins, 1);
    assert.equal(server.refreshes, 1);
    assert.equal(
      server.operations('Refresh')[0].headers.authorization,
      undefined
    );
  });

  it('renews after an HTTP 401 or a token-misuse 400', async () => {
    for (const rejection of [
      { status: 401 },
      { status: 400, body: 'Cannot use refresh token to access' },
    ]) {
      const server = await start();
      server.onOperation('Sources', rejection, NO_SOURCES);
      await connect(server).getSources();
      const [first, second] = server
        .operations('Sources')
        .map((request) => request.headers.authorization);
      assert.notEqual(first, second);
      assert.equal(server.refreshes, 1);
    }
  });

  it('logs in again when the refresh token has expired too', async () => {
    const server = await start();
    server.onOperation('Sources', NO_SOURCES);
    const api = connect(server);
    await api.getSources();
    server.expireAccessTokens();
    server.expireRefreshTokens();
    await api.getSources();
    assert.equal(server.refreshes, 1);
    assert.equal(server.logins, 2);
  });

  it('shares one refresh between concurrent calls', async () => {
    const server = await start();
    server.onOperation('Sources', NO_SOURCES);
    const api = connect(server);
    await api.getSources();
    server.expireAccessTokens();
    await Promise.all(Array.from({ length: 5 }, () => api.getSources()));
    assert.equal(server.refreshes, 1);
    assert.equal(server.logins, 1);
  });

  it('renews only once when the new token is rejected as well', async () => {
    const server = await start();
    server.onOperation('Sources', graphqlErrors(['Unauthorized']));
    await assert.rejects(connect(server).getSources(), {
      code: 'AUTH_REQUIRED',
    });
    assert.equal(server.operations('Sources').length, 2);
  });

  it('lets a caller stop waiting for a login without cancelling it for others', async () => {
    const server = await start();
    server.onOperation('Login', { hang: true });
    const api = connect(server, { timeouts: { mutation: 500 } });
    const controller = new AbortController();
    const cancelled = api.getSources({ signal: controller.signal });
    const waiting = api.getSources();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(cancelled, { code: 'ABORTED' });
    // The shared login carried on until its own timeout.
    await assert.rejects(waiting, { code: 'TIMEOUT' });
    assert.equal(server.operations('Login').length, 1);
    assert.equal(server.operations('Sources').length, 0);
  });

  it('never logs the password or a token when calls fail', async () => {
    const logs = captureLogs();
    const server = await start();
    const wrong = connect(server, {
      auth: { mode: 'UI_LOGIN', username: USERNAME, password: `${PASSWORD}x` },
    });
    await assert.rejects(wrong.getSources(), { code: 'AUTH_FAILED' });
    server.onOperation('Sources', graphqlErrors([syntheticFailure()]));
    await assert.rejects(connect(server).getSources(), {
      code: 'UPSTREAM_ERROR',
    });

    const tokens = server.issuedTokens();
    assert.ok(tokens.length >= 2);
    const output = logs.text();
    assert.match(output, /AUTH_FAILED/);
    assert.match(output, /UPSTREAM_ERROR/);
    for (const secret of [PASSWORD, ...tokens]) {
      assert.ok(!output.includes(secret));
    }
    assert.doesNotMatch(output, /FakeFailure|Incorrect username|Bearer|Basic /);
  });
});

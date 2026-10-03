import { ROOT_FIELDS } from '@server/api/suwayomi/operations';
import type {
  SuwayomiConnectionTestErrorCode,
  SuwayomiConnectionTestFailure,
  SuwayomiConnectionTestResponse,
  SuwayomiConnectionTestResult,
} from '@server/interfaces/api/suwayomiInterfaces';
import { createSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import {
  runSuwayomiConnectionTest,
  SUWAYOMI_CONNECTION_TEST_MESSAGES,
} from '@server/lib/suwayomi/connectionTest';
import logger from '@server/logger';
import {
  capabilitiesData,
  FAKE_VERSION,
  graphqlData,
  graphqlErrors,
  startFakeSuwayomi,
  syntheticFailure,
  type FakeReply,
  type FakeSuwayomi,
  type FakeSuwayomiOptions,
} from '@server/test/fakeSuwayomi';
import type { SuwayomiConnectionTestInput } from '@server/utils/suwayomiSettings';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

const USERNAME = 'fake-user';
const PASSWORD = randomUUID();
const FAILURE_LOG = 'Suwayomi connection test failed';
/** Everything the connection test may send to Suwayomi. */
const ALLOWED_OPERATIONS = new Set([
  'Probe',
  'AuthTest',
  'Login',
  'Refresh',
  'Capabilities',
  'Health',
  'Sources',
]);
const TOKEN_OPERATIONS = new Set(['Login', 'Refresh']);
const servers: FakeSuwayomi[] = [];

const health = ({
  settings = { downloadAsCbz: true },
  queue = [{ state: 'QUEUED' }],
  totalCount = 3,
}: {
  settings?: Record<string, unknown>;
  queue?: { state: string }[];
  totalCount?: number;
} = {}) =>
  graphqlData({
    aboutServer: { version: FAKE_VERSION },
    settings,
    downloadStatus: { state: 'STARTED', queue },
    sources: { totalCount },
  });

const LOCAL_SOURCE = {
  id: '0',
  name: 'Local source',
  displayName: 'Local source',
  lang: 'localsourcelang',
  contentWarning: 'SAFE',
  supportsLatest: false,
  extension: null,
};
const SOURCE_A = {
  id: '4000000000000000001',
  name: 'Source A',
  displayName: 'Source A (EN)',
  lang: 'en',
  contentWarning: 'SAFE',
  supportsLatest: true,
  extension: { hasUpdate: false, isObsolete: false },
};
const SOURCE_B = {
  id: '4000000000000000002',
  name: 'Source B',
  displayName: 'Source B (JA)',
  lang: 'ja',
  contentWarning: 'NSFW',
  supportsLatest: false,
  extension: { hasUpdate: true, isObsolete: true },
};
const MISSING_SOURCE_ID = '4000000000000000009';

const start = async (options: FakeSuwayomiOptions = {}) => {
  const server = await startFakeSuwayomi({
    username: USERNAME,
    password: PASSWORD,
    ...options,
  });
  servers.push(server);
  server.onOperation('Capabilities', capabilitiesData());
  server.onOperation('Health', health());
  server.onOperation(
    'Sources',
    graphqlData({ sources: { nodes: [LOCAL_SOURCE, SOURCE_A, SOURCE_B] } })
  );
  return server;
};

const inputFor = (
  server: FakeSuwayomi,
  overrides: Partial<SuwayomiConnectionTestInput> = {}
): SuwayomiConnectionTestInput => {
  const url = new URL(server.url);
  return {
    hostname: url.hostname,
    port: Number(url.port),
    useSsl: false,
    baseUrl: url.pathname.replace(/\/$/, '') || undefined,
    username: USERNAME,
    password: PASSWORD,
    requireCbz: true,
    sourceAllowlist: [],
    ...overrides,
  };
};

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
    failures: () =>
      calls.filter(
        ([level, message]) => level === 'warn' && message === FAILURE_LOG
      ),
    text: () => inspect(calls, { depth: 10, breakLength: Infinity }),
  };
};

const expectSuccess = (
  result: SuwayomiConnectionTestResponse
): SuwayomiConnectionTestResult => {
  assert.ok(result.success, inspect(result));
  return result;
};

const expectFailure = (
  result: SuwayomiConnectionTestResponse,
  code: SuwayomiConnectionTestErrorCode
): SuwayomiConnectionTestFailure => {
  assert.ok(!result.success, inspect(result));
  assert.equal(result.code, code);
  assert.equal(result.message, SUWAYOMI_CONNECTION_TEST_MESSAGES[code]);
  return result;
};

/** Neither the result nor the log may carry a secret or upstream text. */
const assertNoLeaks = (
  result: SuwayomiConnectionTestResponse,
  logs: ReturnType<typeof captureLogs>,
  server: FakeSuwayomi | undefined,
  extra: string[] = []
) => {
  const forbidden = [
    PASSWORD,
    'Incorrect',
    'Unauthorized',
    'FakeFailureException',
    ...(server?.issuedTokens() ?? []),
    ...extra,
  ];
  const output = `${JSON.stringify(result)}\n${logs.text()}`;
  for (const value of forbidden) {
    assert.ok(!output.includes(value), `leaked ${value.slice(0, 12)}`);
  }
};

const operationNames = (server: FakeSuwayomi) =>
  server.requests.map(({ operationName }) => operationName);

afterEach(async () => {
  mock.restoreAll();
  try {
    for (const server of servers) {
      for (const request of server.requests) {
        assert.equal(request.method, 'POST');
        assert.match(
          new URL(request.url, 'http://fake').pathname,
          /\/api\/graphql$/
        );
        // A request outside the base path never reached the API.
        if (request.query === undefined) continue;
        const name = request.operationName ?? '';
        assert.ok(ALLOWED_OPERATIONS.has(name), name);
        assert.ok(!request.query.includes('pkgName'), name);
        if (TOKEN_OPERATIONS.has(name)) continue;
        assert.doesNotMatch(request.query, /^\s*mutation\b/, name);
        assert.doesNotMatch(
          request.query,
          /password|username|token|secret|proxy/i,
          name
        );
      }
    }
  } finally {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  }
});

describe('runSuwayomiConnectionTest authentication', () => {
  it('detects UI login, checks the server and lists its sources', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'UI_LOGIN' });

    const result = expectSuccess(
      await runSuwayomiConnectionTest(inputFor(server))
    );

    assert.deepEqual(result, {
      success: true,
      authMode: 'UI_LOGIN',
      version: FAKE_VERSION,
      capabilities: {
        revision: 2366,
        buildType: 'Stable',
        supported: true,
        missingFields: [],
      },
      health: {
        downloaderState: 'STARTED',
        queueLength: 1,
        queueErrors: 0,
        sourceCount: 2,
        downloadAsCbz: true,
      },
      warnings: [],
      sources: [SOURCE_A, SOURCE_B].map((source) => ({
        id: source.id,
        name: source.name,
        displayName: source.displayName,
        lang: source.lang,
        contentWarning: source.contentWarning,
        hasUpdate: source.extension.hasUpdate,
        isObsolete: source.extension.isObsolete,
      })),
    });
    assert.equal(server.logins, 1);
    assert.deepEqual(operationNames(server), [
      'Probe',
      'AuthTest',
      'Login',
      'AuthTest',
      'Capabilities',
      'Health',
      'Sources',
    ]);
    assert.equal(logs.failures().length, 0);
    assertNoLeaks(result, logs, server);
  });

  it('reports disabled authentication and never signs in', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'NONE' });

    const result = expectSuccess(
      await runSuwayomiConnectionTest(inputFor(server))
    );

    assert.equal(result.authMode, 'NONE');
    assert.deepEqual(result.warnings, [{ code: 'AUTH_DISABLED' }]);
    assert.equal(server.logins, 0);
    assert.deepEqual(operationNames(server), [
      'Probe',
      'AuthTest',
      'Capabilities',
      'Health',
      'Sources',
    ]);
    assert.ok(
      server.requests.every(
        (request) => request.headers.authorization === undefined
      )
    );
    assertNoLeaks(result, logs, server);
  });

  it('warns when a configured credential is empty', async () => {
    const server = await start({ mode: 'NONE' });

    const result = expectSuccess(
      await runSuwayomiConnectionTest(inputFor(server, { password: '' }))
    );

    assert.deepEqual(result.warnings, [
      { code: 'AUTH_DISABLED' },
      { code: 'EMPTY_CREDENTIALS' },
    ]);
  });

  it('leaves the insecure-mode log warning to the stored client', async () => {
    const logs = captureLogs();
    const none = await start({ mode: 'NONE' });
    const basic = await start({ mode: 'BASIC_AUTH' });
    const warnings = () => logs.calls.filter(([level]) => level === 'warn');

    expectSuccess(await runSuwayomiConnectionTest(inputFor(none)));
    expectSuccess(await runSuwayomiConnectionTest(inputFor(basic)));
    assert.deepEqual(warnings(), []);

    // The clients that later layers keep for these servers still warn once.
    createSuwayomiClient({ ...inputFor(none), authMode: 'NONE' });
    createSuwayomiClient({ ...inputFor(basic), authMode: 'BASIC_AUTH' });
    assert.equal(warnings().length, 2, logs.text());
  });

  it('detects Basic authentication and checks its credentials', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'BASIC_AUTH' });

    const result = expectSuccess(
      await runSuwayomiConnectionTest(inputFor(server))
    );

    assert.equal(result.authMode, 'BASIC_AUTH');
    assert.deepEqual(result.warnings, [{ code: 'BASIC_AUTH_IN_USE' }]);
    assert.equal(server.logins, 0);
    assert.deepEqual(operationNames(server), [
      'Probe',
      'Probe',
      'AuthTest',
      'Capabilities',
      'Health',
      'Sources',
    ]);
    assertNoLeaks(result, logs, server);
  });

  it('rejects wrong or missing Basic credentials', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'BASIC_AUTH' });
    const wrongPassword = randomUUID();

    const wrong = expectFailure(
      await runSuwayomiConnectionTest(
        inputFor(server, { password: wrongPassword })
      ),
      'SUWAYOMI_AUTH_FAILED'
    );
    assert.equal(wrong.authMode, 'BASIC_AUTH');
    assertNoLeaks(wrong, logs, server, [wrongPassword]);

    const missing = expectFailure(
      await runSuwayomiConnectionTest(
        inputFor(server, { username: '', password: '' })
      ),
      'SUWAYOMI_CREDENTIALS_REQUIRED'
    );
    assert.equal(missing.authMode, 'BASIC_AUTH');
    assert.equal(server.operations('Capabilities').length, 0);
  });

  it('refuses simple login', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'SIMPLE_LOGIN' });

    const result = expectFailure(
      await runSuwayomiConnectionTest(inputFor(server)),
      'SUWAYOMI_SIMPLE_LOGIN_UNSUPPORTED'
    );

    assert.equal(result.authMode, 'SIMPLE_LOGIN');
    assert.equal(server.operations('Capabilities').length, 0);
    assertNoLeaks(result, logs, server);
  });

  it('asks for credentials when Suwayomi requires a login', async () => {
    const server = await start({ mode: 'UI_LOGIN' });

    const result = expectFailure(
      await runSuwayomiConnectionTest(
        inputFor(server, { username: '', password: '' })
      ),
      'SUWAYOMI_CREDENTIALS_REQUIRED'
    );

    assert.equal(result.authMode, 'LOGIN_REQUIRED');
    assert.equal(server.logins, 0);
    assert.equal(server.operations('Login').length, 0);
  });

  it('reports a rejected login without Suwayomi’s text or the password', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'UI_LOGIN' });
    const wrongPassword = randomUUID();

    const result = expectFailure(
      await runSuwayomiConnectionTest(
        inputFor(server, { password: wrongPassword })
      ),
      'SUWAYOMI_AUTH_FAILED'
    );

    assert.equal(result.authMode, undefined);
    assert.equal(server.logins, 0);
    const failures = logs.failures();
    assert.equal(failures.length, 1);
    const meta = failures[0][2] as Record<string, unknown>;
    assert.equal(meta.label, 'Suwayomi');
    assert.equal(meta.code, 'SUWAYOMI_AUTH_FAILED');
    assertNoLeaks(result, logs, server, [wrongPassword]);
  });
});

describe('runSuwayomiConnectionTest server checks', () => {
  it('reports a server that cannot be reached', async () => {
    const logs = captureLogs();
    const closed = await startFakeSuwayomi();
    const input = inputFor(closed);
    await closed.close();

    const result = expectFailure(
      await runSuwayomiConnectionTest(input),
      'SUWAYOMI_UNREACHABLE'
    );

    assert.equal(result.authMode, undefined);
    assert.equal(logs.failures().length, 1);
  });

  it('reports an address that does not answer like Suwayomi', async () => {
    const logs = captureLogs();
    const nested = await start({ basePath: '/suwayomi' });
    expectFailure(
      await runSuwayomiConnectionTest(inputFor(nested, { baseUrl: undefined })),
      'SUWAYOMI_NOT_SUWAYOMI'
    );
    expectSuccess(await runSuwayomiConnectionTest(inputFor(nested)));

    const other = await start({ mode: 'NONE' });
    other.onOperation('Probe', {
      headers: { 'Content-Type': 'text/html' },
      body: '<!doctype html><title>Another app</title>',
    });
    const result = expectFailure(
      await runSuwayomiConnectionTest(inputFor(other)),
      'SUWAYOMI_NOT_SUWAYOMI'
    );
    assertNoLeaks(result, logs, other, ['Another app']);
  });

  it('names the missing features of an unsupported server', async () => {
    const server = await start({ mode: 'UI_LOGIN' });
    server.onOperation(
      'Capabilities',
      capabilitiesData({
        mutationFields: ROOT_FIELDS.mutation.filter(
          (field) => field !== 'fetchMangaAndChapters'
        ),
      })
    );

    const result = expectFailure(
      await runSuwayomiConnectionTest(inputFor(server)),
      'SUWAYOMI_UNSUPPORTED_SERVER'
    );

    assert.equal(result.authMode, 'UI_LOGIN');
    assert.equal(result.version, FAKE_VERSION);
    assert.deepEqual(result.missingFields, ['Mutation.fetchMangaAndChapters']);
    assert.equal(server.operations('Health').length, 0);
  });

  it('refuses an old server whose schema cannot be read', async () => {
    const server = await start({ mode: 'UI_LOGIN' });
    server.onOperation(
      'Probe',
      graphqlData({
        aboutServer: {
          name: 'Suwayomi-Server',
          version: 'v2.2.2100',
          buildType: 'Stable',
        },
      })
    );
    server.onOperation(
      'Capabilities',
      graphqlErrors([syntheticFailure('introspection disabled')])
    );

    const result = expectFailure(
      await runSuwayomiConnectionTest(inputFor(server)),
      'SUWAYOMI_UNSUPPORTED_SERVER'
    );

    assert.equal(result.version, 'v2.2.2100');
    assert.deepEqual(result.missingFields, []);
    assert.deepEqual(result.warnings, [
      { code: 'BELOW_PINNED_REVISION' },
      { code: 'INTROSPECTION_UNAVAILABLE' },
    ]);
  });

  it('warns about the version and schema without failing', async () => {
    const cases: [FakeReply, string, number?][] = [
      [
        capabilitiesData({ version: 'v2.3.2300' }),
        'BELOW_PINNED_REVISION',
        2300,
      ],
      [capabilitiesData({ version: 'custom-build' }), 'UNKNOWN_VERSION'],
      [
        graphqlErrors([syntheticFailure('introspection disabled')]),
        'INTROSPECTION_UNAVAILABLE',
        2366,
      ],
      [
        capabilitiesData({ mangaFields: ['id', 'title', 'user'] }),
        'PER_USER_SCHEMA',
        2366,
      ],
    ];
    for (const [reply, code, revision] of cases) {
      const server = await start({ mode: 'NONE' });
      server.onOperation('Capabilities', reply);

      const result = expectSuccess(
        await runSuwayomiConnectionTest(inputFor(server))
      );

      assert.deepEqual(
        result.warnings.map((warning) => warning.code),
        ['AUTH_DISABLED', code],
        code
      );
      assert.equal(result.capabilities.revision, revision, code);
      assert.equal(result.capabilities.supported, true, code);
    }
  });

  it('requires sources besides the local one', async () => {
    const server = await start({ mode: 'UI_LOGIN' });
    server.onOperation('Health', health({ totalCount: 1 }));

    expectFailure(
      await runSuwayomiConnectionTest(inputFor(server)),
      'SUWAYOMI_NO_SOURCES'
    );
    assert.equal(server.operations('Sources').length, 0);
  });

  it('requires CBZ downloads unless the admin allows other formats', async () => {
    const server = await start({ mode: 'UI_LOGIN' });
    for (const settings of [{ downloadAsCbz: false }, {}]) {
      server.onOperation('Health', health({ settings }));
      expectFailure(
        await runSuwayomiConnectionTest(inputFor(server)),
        'SUWAYOMI_CBZ_REQUIRED'
      );
    }
    assert.equal(server.operations('Sources').length, 0);

    server.onOperation(
      'Health',
      health({ settings: { downloadAsCbz: false } })
    );
    const allowed = expectSuccess(
      await runSuwayomiConnectionTest(inputFor(server, { requireCbz: false }))
    );
    assert.deepEqual(allowed.warnings, [{ code: 'CBZ_DISABLED' }]);
    assert.equal(allowed.health.downloadAsCbz, false);
  });

  it('counts queue items that failed', async () => {
    const server = await start({ mode: 'UI_LOGIN' });
    server.onOperation(
      'Health',
      health({
        queue: [{ state: 'ERROR' }, { state: 'QUEUED' }, { state: 'ERROR' }],
      })
    );

    const result = expectSuccess(
      await runSuwayomiConnectionTest(inputFor(server))
    );

    assert.deepEqual(result.warnings, [{ code: 'QUEUE_ERRORS', count: 2 }]);
    assert.equal(result.health.queueLength, 3);
    assert.equal(result.health.queueErrors, 2);
  });

  it('flags allowlisted sources that are outdated, obsolete or missing', async () => {
    const server = await start({ mode: 'UI_LOGIN' });

    const result = expectSuccess(
      await runSuwayomiConnectionTest(
        inputFor(server, {
          sourceAllowlist: [SOURCE_A.id, SOURCE_B.id, MISSING_SOURCE_ID],
        })
      )
    );

    assert.deepEqual(result.warnings, [
      { code: 'SOURCE_UPDATE_AVAILABLE', sourceIds: [SOURCE_B.id] },
      { code: 'SOURCE_OBSOLETE', sourceIds: [SOURCE_B.id] },
      { code: 'SOURCE_MISSING', sourceIds: [MISSING_SOURCE_ID] },
    ]);
  });

  it('orders warnings from the most to the least urgent', async () => {
    const server = await start({ mode: 'NONE' });
    server.onOperation(
      'Capabilities',
      capabilitiesData({ version: 'v2.3.2300' })
    );
    server.onOperation(
      'Health',
      health({
        settings: { downloadAsCbz: false },
        queue: [{ state: 'ERROR' }],
      })
    );

    const result = expectSuccess(
      await runSuwayomiConnectionTest(
        inputFor(server, {
          requireCbz: false,
          sourceAllowlist: [MISSING_SOURCE_ID],
        })
      )
    );

    assert.deepEqual(
      result.warnings.map((warning) => warning.code),
      [
        'AUTH_DISABLED',
        'CBZ_DISABLED',
        'QUEUE_ERRORS',
        'BELOW_PINNED_REVISION',
        'SOURCE_MISSING',
      ]
    );
  });
});

describe('runSuwayomiConnectionTest failures', () => {
  it('stops at the overall deadline', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'UI_LOGIN' });
    server.onOperation('Capabilities', { hang: true });
    const startedAt = Date.now();

    const result = expectFailure(
      await runSuwayomiConnectionTest(inputFor(server), { deadlineMs: 300 }),
      'SUWAYOMI_TIMEOUT'
    );

    assert.ok(Date.now() - startedAt < 10_000);
    assert.equal(result.authMode, 'UI_LOGIN');
    const [hung] = server.operations('Capabilities');
    assert.equal(await hung.closed, false);
    assert.equal(server.operations('Health').length, 0);
    assert.equal(logs.failures().length, 1);
  });

  it('stops when the caller gives up', async () => {
    const server = await start({ mode: 'UI_LOGIN' });
    const controller = new AbortController();
    server.onOperation('Health', () => {
      controller.abort();
      return { hang: true };
    });

    expectFailure(
      await runSuwayomiConnectionTest(inputFor(server), {
        signal: controller.signal,
      }),
      'SUWAYOMI_TIMEOUT'
    );
    const [hung] = server.operations('Health');
    assert.equal(await hung.closed, false);

    expectFailure(
      await runSuwayomiConnectionTest(inputFor(server), {
        signal: AbortSignal.abort(),
      }),
      'SUWAYOMI_TIMEOUT'
    );
  });

  it('never returns or logs Suwayomi’s error text', async () => {
    const logs = captureLogs();
    const marker = `marker-${randomUUID()}`;
    const server = await start({ mode: 'UI_LOGIN' });

    server.onOperation('Health', graphqlErrors([syntheticFailure(marker)]));
    const graphqlFailure = expectFailure(
      await runSuwayomiConnectionTest(inputFor(server)),
      'SUWAYOMI_UPSTREAM_ERROR'
    );
    assertNoLeaks(graphqlFailure, logs, server, [marker]);

    server.onOperation('Health', health());
    server.onOperation('Sources', {
      status: 500,
      body: syntheticFailure(marker),
    });
    const httpFailure = expectFailure(
      await runSuwayomiConnectionTest(inputFor(server)),
      'SUWAYOMI_UPSTREAM_ERROR'
    );
    assertNoLeaks(httpFailure, logs, server, [marker]);

    server.onOperation('Login', graphqlErrors([syntheticFailure(marker)]));
    const loginFailure = await runSuwayomiConnectionTest(inputFor(server));
    assert.ok(!loginFailure.success);
    assertNoLeaks(loginFailure, logs, server, [marker]);

    assert.equal(logs.failures().length, 3);
    for (const [, , meta] of logs.failures()) {
      assert.deepEqual(Object.keys(meta as object).sort(), [
        'code',
        'label',
        'operation',
      ]);
    }
  });
});

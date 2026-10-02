import SuwayomiAPI from '@server/api/suwayomi';
import type { SuwayomiAPIOptions } from '@server/api/suwayomi/types';
import logger from '@server/logger';
import {
  startFakeSuwayomi,
  type FakeSuwayomi,
  type FakeSuwayomiOptions,
} from '@server/test/fakeSuwayomi';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, it, mock } from 'node:test';

const USERNAME = 'fake-user';
const PASSWORD = randomUUID();
const BASIC_AUTH = {
  mode: 'BASIC_AUTH',
  username: USERNAME,
  password: PASSWORD,
} as const;
const DISABLED = /authentication is disabled/;
const servers: FakeSuwayomi[] = [];

// The client records each warned origin for the life of the process. Every
// server stays up until the file ends, so no test reuses another's origin.
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

const captureLogs = () => {
  const calls: unknown[][] = [];
  for (const level of ['error', 'warn', 'info', 'debug', 'verbose'] as const) {
    mock.method(logger, level, (...args: unknown[]) => {
      calls.push([level, ...args]);
      return logger;
    });
  }
  return calls;
};

const assertWarnedOnce = (calls: unknown[][], pattern: RegExp) => {
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'warn');
  assert.match(String(calls[0][1]), pattern);
};

afterEach(() => {
  mock.restoreAll();
});

after(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('SuwayomiAPI insecure auth-mode warning', () => {
  it('lets a diagnostic client skip the warning without using it up', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'NONE' });
    const diagnostic = connect(server, {
      auth: { mode: 'NONE' },
      warnInsecureAuthMode: false,
    });
    assert.deepEqual(await diagnostic.detectAuthMode(), {
      mode: 'NONE',
      supported: true,
      authenticated: true,
      matchesConfigured: true,
      warnings: ['AUTH_DISABLED'],
    });
    assert.deepEqual(logs, []);

    connect(server, { auth: { mode: 'NONE' } });
    assertWarnedOnce(logs, DISABLED);
  });

  it('skips the warning when detection finds an insecure mode', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'NONE' });
    const detection = await connect(server, {
      warnInsecureAuthMode: false,
    }).detectAuthMode();
    assert.deepEqual(detection, {
      mode: 'NONE',
      supported: true,
      authenticated: false,
      matchesConfigured: false,
      warnings: ['MODE_MISMATCH', 'AUTH_DISABLED'],
    });
    assert.deepEqual(logs, []);

    await connect(server).detectAuthMode();
    assertWarnedOnce(logs, DISABLED);
  });

  it('skips the Basic authentication warning for a diagnostic client', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'BASIC_AUTH' });
    const detection = await connect(server, {
      auth: BASIC_AUTH,
      warnInsecureAuthMode: false,
    }).detectAuthMode();
    assert.deepEqual(detection.warnings, ['BASIC_AUTH_IN_USE']);
    assert.deepEqual(logs, []);

    connect(server, { auth: BASIC_AUTH });
    assertWarnedOnce(logs, /Basic authentication/);
  });

  it('still warns once per server by default', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'NONE' });
    const api = connect(server, { auth: { mode: 'NONE' } });
    assertWarnedOnce(logs, DISABLED);

    const detection = await api.detectAuthMode();
    assert.deepEqual(detection.warnings, ['AUTH_DISABLED']);
    connect(server, { auth: { mode: 'NONE' }, warnInsecureAuthMode: true });
    await connect(server).detectAuthMode();
    assertWarnedOnce(logs, DISABLED);
  });

  it('turns the warning off only for an explicit false', async () => {
    const logs = captureLogs();
    const server = await start({ mode: 'NONE' });
    connect(server, {
      auth: { mode: 'NONE' },
      warnInsecureAuthMode: 'false' as never,
    });
    assertWarnedOnce(logs, DISABLED);
  });
});

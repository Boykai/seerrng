import {
  SuwayomiTokenManager,
  TOKEN_REFRESH_MARGIN_MS,
  basicAuthorization,
  decodeJwtExpiry,
  type SuwayomiTokenHandlers,
} from '@server/api/suwayomi/auth';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import { createFakeJwt } from '@server/test/fakeSuwayomi';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const START = 1_700_000_000_000;

const setup = (accessTtl = 300, refreshTtl = 3_600) => {
  let now = START;
  const issue = (ttl: number) =>
    createFakeJwt({ exp: Math.floor(now / 1_000) + ttl });
  const calls = { login: 0, refresh: 0 };
  const handlers: SuwayomiTokenHandlers = {
    login: async () => {
      calls.login += 1;
      return { accessToken: issue(accessTtl), refreshToken: issue(refreshTtl) };
    },
    refresh: async () => {
      calls.refresh += 1;
      return issue(accessTtl);
    },
  };
  const manager = new SuwayomiTokenManager(handlers, () => now);
  return {
    manager,
    handlers,
    calls,
    issue,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('decodeJwtExpiry', () => {
  it('reads exp in milliseconds', () => {
    assert.equal(decodeJwtExpiry(createFakeJwt({ exp: 1_000 })), 1_000_000);
  });

  it('ignores tokens without a usable exp', () => {
    const encode = (value: string) =>
      Buffer.from(value, 'utf8').toString('base64url');
    for (const token of [
      'not-a-token',
      createFakeJwt({}),
      `a.${encode('not json')}.c`,
      `a.${encode('{"exp":"soon"}')}.c`,
      `a.${encode('{"exp":1e400}')}.c`,
      `a.${'x'.repeat(8_193)}.c`,
    ]) {
      assert.equal(decodeJwtExpiry(token), undefined, token.slice(0, 40));
    }
  });
});

describe('basicAuthorization', () => {
  it('encodes UTF-8 credentials', () => {
    assert.equal(
      basicAuthorization('user', 'pässword'),
      `Basic ${Buffer.from('user:pässword', 'utf8').toString('base64')}`
    );
  });
});

describe('SuwayomiTokenManager', () => {
  it('logs in once and reuses a fresh access token', async () => {
    const { manager, calls } = setup();
    const first = await manager.getAccessToken();
    assert.equal(await manager.getAccessToken(), first);
    assert.deepEqual(calls, { login: 1, refresh: 0 });
  });

  it('refreshes before the access token expires', async () => {
    const { manager, calls, advance } = setup();
    const first = await manager.getAccessToken();
    advance(300_000 - TOKEN_REFRESH_MARGIN_MS - 1);
    assert.equal(await manager.getAccessToken(), first);
    advance(2);
    const second = await manager.getAccessToken();
    assert.notEqual(second, first);
    assert.deepEqual(calls, { login: 1, refresh: 1 });
  });

  it('keeps the renewal margin below half of a short token lifetime', async () => {
    const { manager, calls, advance } = setup(20);
    const first = await manager.getAccessToken();
    advance(9_000);
    assert.equal(await manager.getAccessToken(), first);
    advance(1_001);
    assert.notEqual(await manager.getAccessToken(), first);
    assert.equal(calls.refresh, 1);
  });

  it('shares one renewal between concurrent callers', async () => {
    const { manager, calls } = setup();
    const stale = await manager.getAccessToken();
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => manager.renew(stale))
    );
    assert.equal(new Set(tokens).size, 1);
    assert.notEqual(tokens[0], stale);
    assert.deepEqual(calls, { login: 1, refresh: 1 });
  });

  it('does not renew a token another caller already replaced', async () => {
    const { manager, calls } = setup();
    const stale = await manager.getAccessToken();
    const current = await manager.renew(stale);
    assert.equal(await manager.renew(stale), current);
    assert.equal(calls.refresh, 1);
  });

  it('logs in again when the refresh token has expired', async () => {
    const { manager, calls, advance } = setup(300, 600);
    await manager.getAccessToken();
    advance(600_000);
    await manager.getAccessToken();
    assert.deepEqual(calls, { login: 2, refresh: 0 });
  });

  it('logs in again when Suwayomi rejects the refresh token', async () => {
    const { manager, calls, handlers } = setup();
    const stale = await manager.getAccessToken();
    handlers.refresh = async () => {
      calls.refresh += 1;
      throw new SuwayomiError('UPSTREAM_ERROR', 'Refresh');
    };
    assert.notEqual(await manager.renew(stale), stale);
    assert.deepEqual(calls, { login: 2, refresh: 1 });
  });

  it('does not try to log in when the server cannot be reached', async () => {
    const { manager, calls, handlers } = setup();
    const stale = await manager.getAccessToken();
    handlers.refresh = async () => {
      throw new SuwayomiError('UNREACHABLE', 'Refresh');
    };
    await assert.rejects(manager.renew(stale), { code: 'UNREACHABLE' });
    assert.equal(calls.login, 1);
  });

  it('retries after a failed login instead of caching the failure', async () => {
    const { manager, calls, handlers } = setup();
    const login = handlers.login;
    handlers.login = async () => {
      calls.login += 1;
      throw new SuwayomiError('AUTH_FAILED', 'Login');
    };
    await assert.rejects(manager.getAccessToken(), { code: 'AUTH_FAILED' });
    handlers.login = login;
    assert.ok(await manager.getAccessToken());
    assert.equal(calls.login, 2);
  });

  it('renews only on rejection when a token has no usable expiry', async () => {
    const { manager, calls, handlers, advance } = setup();
    handlers.login = async () => {
      calls.login += 1;
      return { accessToken: 'a.b.c', refreshToken: 'd.e.f' };
    };
    const token = await manager.getAccessToken();
    advance(86_400_000);
    assert.equal(await manager.getAccessToken(), token);
    assert.notEqual(await manager.renew(token), token);
    assert.deepEqual(calls, { login: 1, refresh: 1 });
  });

  it('forgets every token when cleared', async () => {
    const { manager, calls } = setup();
    await manager.getAccessToken();
    manager.clear();
    await manager.getAccessToken();
    assert.deepEqual(calls, { login: 2, refresh: 0 });
  });

  it('stops only the aborted caller from waiting for a shared renewal', async () => {
    const { manager, calls, handlers } = setup();
    let finishLogin: (() => void) | undefined;
    const login = handlers.login;
    handlers.login = () =>
      new Promise((resolve) => {
        finishLogin = () => resolve(login());
      });
    const controller = new AbortController();
    const cancelled = manager.getAccessToken(controller.signal);
    const waiting = manager.getAccessToken();
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    finishLogin?.();
    assert.ok(await waiting);
    assert.equal(calls.login, 1);
  });

  it('does not start a renewal for a caller that has already aborted', async () => {
    const { manager, calls } = setup();
    await assert.rejects(manager.getAccessToken(AbortSignal.abort()), {
      name: 'AbortError',
    });
    assert.equal(calls.login, 0);
  });
});

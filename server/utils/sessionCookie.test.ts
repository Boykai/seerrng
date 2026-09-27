import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { getSessionTransportOptions } from './sessionCookie';

const createApp = (development = false, allowHttpAuth = true) => {
  const app = express();
  const sessionTransportOptions = getSessionTransportOptions(
    development,
    true,
    allowHttpAuth
  );
  app.use(
    // This synthetic app verifies the explicit HTTP compatibility mode.
    // codeql[js/clear-text-cookie]
    session({
      secret: '01234567890123456789012345678901',
      resave: false,
      saveUninitialized: false,
      cookie: {
        ...sessionTransportOptions.cookie,
      },
      proxy: sessionTransportOptions.proxy,
    })
  );
  app.get('/', (req, res) => {
    req.session.userId = 1;
    res.json({ ok: true });
  });
  return app;
};

describe('getSessionTransportOptions', () => {
  it('uses transport-aware cookies by default', () => {
    assert.equal(getSessionTransportOptions(false, true).cookie.secure, 'auto');
    assert.equal(
      getSessionTransportOptions(false, false, false).cookie.secure,
      true
    );
    assert.equal(getSessionTransportOptions(false, true).proxy, true);
  });

  it('allows the explicit HTTP fallback to remain transport-aware', () => {
    assert.equal(
      getSessionTransportOptions(false, true, true).cookie.secure,
      'auto'
    );
    assert.equal(
      getSessionTransportOptions(false, false, true).cookie.secure,
      'auto'
    );
  });

  it('keeps the remaining cookie protections in development and production', () => {
    assert.equal(
      getSessionTransportOptions(true, true, false).cookie.secure,
      true
    );
    assert.equal(
      getSessionTransportOptions(true, true).cookie.sameSite,
      'strict'
    );
    assert.equal(
      getSessionTransportOptions(true, false).cookie.sameSite,
      'lax'
    );
    assert.equal(
      getSessionTransportOptions(true, true, false).cookie.httpOnly,
      true
    );
    assert.equal(
      getSessionTransportOptions(true, true, false).cookie.maxAge,
      30 * 24 * 60 * 60 * 1_000
    );
    assert.equal(getSessionTransportOptions(true, true, false).proxy, false);
  });

  it('issues a non-Secure session cookie over default HTTP', async () => {
    const directResponse = await request(createApp()).get('/');
    // codeql[js/clear-text-cookie]
    assert.doesNotMatch(
      directResponse.get('Set-Cookie')?.[0] ?? '',
      /; Secure(?:;|$)/
    );

    const response = await request(createApp())
      .get('/')
      .set('X-Forwarded-Proto', 'https');

    assert.match(response.get('Set-Cookie')?.[0] ?? '', /; Secure(?:;|$)/);
  });

  it('does not issue a session cookie when HTTPS-only mode is selected', async () => {
    const response = await request(createApp(false, false)).get('/');
    assert.equal(response.headers['set-cookie'], undefined);
  });
});

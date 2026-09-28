import AnilistAPI from '@server/api/anilist';
import ExternalAPI from '@server/api/externalapi';
import MdblistAPI, {
  MdblistListNotFoundError,
  MdblistQuotaExceededError,
} from '@server/api/mdblist';
import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import DiscoveryAccount from '@server/entity/DiscoveryAccount';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';
import request from 'supertest';
import authRoutes from './auth';
import discoveryRoutes from './discoveryIntegrations';

const app = express();
app.use(express.json());
app.use(
  // This Supertest-only session never listens on a network socket.
  // codeql[js/clear-text-cookie]
  session({
    secret: 'discovery-tests',
    resave: false,
    saveUninitialized: false,
  })
);
// Production checkUser includes the authenticated-route limiter; this in-memory
// test app has no network listener and only exercises authorization behavior.
// codeql[js/missing-rate-limiting]
app.use(checkUser);
app.use('/auth', authRoutes);
app.use('/integrations/discovery', discoveryRoutes);
setupTestDb();
let savedConfiguration: typeof getSettings extends () => infer S
  ? S extends { discoveryIntegrations: infer C }
    ? C
    : never
  : never;
before(() => {
  savedConfiguration = structuredClone(getSettings().discoveryIntegrations);
});
afterEach(() => {
  mock.restoreAll();
  Object.assign(
    getSettings().discoveryIntegrations,
    structuredClone(savedConfiguration)
  );
});
async function login() {
  const agent = request.agent(app);
  getSettings().main.localLogin = true;
  const result = await agent
    .post('/auth/local')
    .send({ email: 'admin@seerr.dev', password: 'test1234' });
  assert.equal(result.status, 200);
  return agent;
}

describe('personal discovery account boundaries', () => {
  it('saves and removes a TMDB-confirmed match for a linked personal library', async () => {
    const agent = await login();
    const admin = await getRepository(User).findOneByOrFail({
      email: 'admin@seerr.dev',
    });
    getSettings().discoveryIntegrations.trakt.clientId = 'test-trakt-app';
    await getRepository(DiscoveryAccount).save({
      userId: admin.id,
      provider: 'trakt',
      clientId: 'test-trakt-app',
      accessToken: 'private-token',
      refreshToken: null,
      expiresAt: null,
      username: 'viewer',
      providerUserId: 'viewer-id',
      allowWrites: false,
    });
    const catalogLookup = mock.method(
      ExternalAPI.prototype as unknown as {
        get: (endpoint: string, ...args: unknown[]) => Promise<unknown>;
      },
      'get',
      async (endpoint: string) => ({
        id: endpoint === '/movie/456' ? 456 : 0,
        title: 'Confirmed title',
      })
    );

    const saved = await agent
      .put('/integrations/discovery/mappings')
      .send({ identity: 'trakt:movie:123', tmdbId: 456, mediaType: 'movie' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.tmdbId, 456);
    assert.equal(saved.body.mediaType, 'movie');
    assert.equal(catalogLookup.mock.callCount(), 1);

    const publicCatalogMatch = await agent
      .put('/integrations/discovery/mappings')
      .send({ identity: 'anilist:123', tmdbId: 456, mediaType: 'movie' });
    assert.equal(publicCatalogMatch.status, 200);
    assert.equal(catalogLookup.mock.callCount(), 2);

    const publicListMatch = await agent
      .put('/integrations/discovery/mappings')
      .send({
        identity: 'mdblist:unknown:tt1234567',
        tmdbId: 456,
        mediaType: 'movie',
      });
    assert.equal(publicListMatch.status, 200);
    assert.equal(catalogLookup.mock.callCount(), 3);

    const unlinked = await agent
      .put('/integrations/discovery/mappings')
      .send({ identity: 'simkl:movies:123', tmdbId: 456, mediaType: 'movie' });
    assert.equal(unlinked.status, 409);

    const removed = await agent.delete(
      `/integrations/discovery/mappings/${encodeURIComponent('trakt:movie:123')}`
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
  });

  it('omits stored tokens and client secrets from account and configuration responses', async () => {
    const agent = await login();
    const admin = await getRepository(User).findOneByOrFail({
      email: 'admin@seerr.dev',
    });
    await getRepository(DiscoveryAccount).save({
      userId: admin.id,
      provider: 'trakt',
      clientId: getSettings().discoveryIntegrations.trakt.clientId,
      accessToken: 'private-access-token',
      refreshToken: 'private-refresh-token',
      username: 'viewer',
      providerUserId: '123',
      allowWrites: false,
    });
    const accounts = await agent.get('/integrations/discovery/accounts');
    assert.equal(accounts.status, 200);
    assert.equal(accounts.body.accounts[0].username, 'viewer');
    assert.equal(JSON.stringify(accounts.body).includes('private-'), false);
    const config = await agent.get('/integrations/discovery/configuration');
    assert.equal(config.status, 200);
    for (const provider of Object.values(config.body) as Record<
      string,
      unknown
    >[]) {
      assert.equal('clientSecret' in provider, false);
      assert.equal('apiKey' in provider, false);
    }
  });
  it('rejects personal mutations originating at another site', async () => {
    const agent = await login();
    const result = await agent
      .delete('/integrations/discovery/accounts/trakt')
      .set('Origin', 'https://attacker.example');
    assert.equal(result.status, 403);
  });
  it('rejects unknown providers and malformed write consent', async () => {
    const agent = await login();
    assert.equal(
      (await agent.delete('/integrations/discovery/accounts/other')).status,
      400
    );
    assert.equal(
      (
        await agent
          .put('/integrations/discovery/accounts/trakt/preferences')
          .send({ allowWrites: 'yes' })
      ).status,
      400
    );
  });
  it('rejects repeated MDBList list query parameters', async () => {
    const agent = await login();
    const result = await agent.get(
      '/integrations/discovery/feeds/mdblist/list?list=hdlists%2Fhorror&list=another%2Flist'
    );
    assert.equal(result.status, 400);
  });
  it('returns a bounded Retry-After when MDBList quota is exhausted', async () => {
    const agent = await login();
    mock.method(MdblistAPI.prototype, 'getListItems', async () => {
      throw new MdblistQuotaExceededError(120);
    });

    const result = await agent.get(
      '/integrations/discovery/feeds/mdblist/list?list=123'
    );

    assert.equal(result.status, 429);
    assert.equal(result.headers['retry-after'], '120');
    assert.equal(result.body.code, 'PROVIDER_RATE_LIMITED');
  });
  it('reports a missing MDBList list as a not-found result', async () => {
    const agent = await login();
    mock.method(MdblistAPI.prototype, 'getListItems', async () => {
      throw new MdblistListNotFoundError();
    });

    const result = await agent.get(
      '/integrations/discovery/feeds/mdblist/list?list=123'
    );

    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'PROVIDER_LIST_NOT_FOUND');
  });
  it('does not accept a browser-supplied Trakt device code', async () => {
    const agent = await login();
    const poll = mock.method(TraktAPI.prototype, 'pollForToken', async () => ({
      status: 'pending' as const,
    }));
    const result = await agent
      .post('/integrations/discovery/accounts/trakt/complete')
      .send({ deviceCode: 'attacker-code' });
    assert.equal(result.status, 409);
    assert.equal(poll.mock.callCount(), 0);
  });
  it('rejects missing AniList PINs before contacting the provider', async () => {
    const agent = await login();
    const exchange = mock.method(AnilistAPI, 'exchangePinCode', async () => ({
      accessToken: 'token',
      expiresAt: 1,
    }));
    assert.equal(
      (
        await agent
          .post('/integrations/discovery/accounts/anilist/complete')
          .send({ code: '' })
      ).status,
      400
    );
    assert.equal(exchange.mock.callCount(), 0);
  });
});

it('retains device credentials server-side, resumes an attempt, and stores authorized tokens correctly', async () => {
  const agent = await login();
  Object.assign(getSettings().discoveryIntegrations.trakt, {
    clientId: 'test-app',
    clientSecret: 'app-secret',
  });
  const start = mock.method(
    TraktAPI.prototype,
    'requestDeviceCode',
    async () => ({
      device_code: 'private-device',
      user_code: 'PUBLIC-CODE',
      verification_url: 'https://trakt.tv/activate',
      expires_in: 600,
      interval: 5,
    })
  );
  const poll = mock.method(
    TraktAPI.prototype,
    'pollForToken',
    async (code: string) => {
      assert.equal(code, 'private-device');
      return {
        status: 'authorized' as const,
        tokens: {
          access_token: 'linked-access',
          refresh_token: 'linked-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          created_at: Math.floor(Date.now() / 1000),
          scope: 'public',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      };
    }
  );
  mock.method(TraktAPI.prototype, 'getUserSettings', async () => ({
    username: 'connected-viewer',
    traktUserId: 'viewer-id',
  }));
  const begin = await agent.post(
    '/integrations/discovery/accounts/trakt/connect'
  );
  assert.equal(begin.status, 200);
  assert.equal(begin.body.userCode, 'PUBLIC-CODE');
  assert.equal(JSON.stringify(begin.body).includes('private-device'), false);
  assert.equal(
    (await agent.post('/integrations/discovery/accounts/trakt/connect')).status,
    200
  );
  assert.equal(start.mock.callCount(), 1);
  assert.equal(
    (
      await agent
        .post('/integrations/discovery/accounts/trakt/complete')
        .send({})
    ).status,
    202
  );
  assert.equal(poll.mock.callCount(), 0);
  const now = Date.now();
  mock.method(Date, 'now', () => now + 6000);
  const completed = await agent
    .post('/integrations/discovery/accounts/trakt/complete')
    .send({});
  assert.equal(completed.status, 200);
  assert.equal(completed.body.status, 'authorized');
  assert.equal(completed.body.account.username, 'connected-viewer');
  assert.equal(JSON.stringify(completed.body).includes('linked-access'), false);
  const account = await getRepository(DiscoveryAccount)
    .createQueryBuilder('account')
    .addSelect(['account.accessToken', 'account.refreshToken'])
    .where('account.provider = :provider', { provider: 'trakt' })
    .getOneOrFail();
  assert.equal(account.accessToken, 'linked-access');
  assert.equal(account.refreshToken, 'linked-refresh');
  assert.equal(account.allowWrites, false);
});

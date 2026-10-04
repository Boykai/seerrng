import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { Permission } from '@server/lib/permissions';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  getSuwayomiClient,
  invalidateSuwayomiClients,
} from '@server/lib/suwayomi/clientFactory';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import {
  capabilitiesData,
  FAKE_VERSION,
  graphqlData,
  startFakeSuwayomi,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import { REDACTED_SECRET } from '@server/utils/security';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';
import request from 'supertest';

setupTestDb();

const BASE = '/api/v1/settings/suwayomi';
const USERNAME = 'fake-user';
const PASSWORD = randomUUID();
const SOURCE_ID = '4000000000000000001';
const servers: FakeSuwayomi[] = [];
/** Responses from the Suwayomi routes that don't match the API spec. */
const responseErrors: string[] = [];
const fromErrorHandler = Symbol('from-error-handler');
type MarkedRequest = express.Request & { [fromErrorHandler]?: true };

const createApp = (userId = 1): Express => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = new User({
      id: userId,
      permissions: userId === 1 ? Permission.ADMIN : Permission.REQUEST,
    });
    next();
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateResponses: {
        onError: (error, _body, req) => {
          // The shared error handler's bodies are generic, as in production.
          if (!(req as MarkedRequest)[fromErrorHandler]) {
            responseErrors.push(`${req.method} ${req.path}: ${error.message}`);
          }
        },
      },
      validateSecurity: false,
    })
  );
  app.use('/api/v1/settings', settingsRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      (req as MarkedRequest)[fromErrorHandler] = true;
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
};

const startFake = async () => {
  const server = await startFakeSuwayomi({
    mode: 'UI_LOGIN',
    username: USERNAME,
    password: PASSWORD,
  });
  servers.push(server);
  server.onOperation('Capabilities', capabilitiesData());
  server.onOperation(
    'Health',
    graphqlData({
      aboutServer: { version: FAKE_VERSION },
      settings: { downloadAsCbz: true },
      downloadStatus: { state: 'STOPPED', queue: [] },
      sources: { totalCount: 2 },
    })
  );
  server.onOperation(
    'Sources',
    graphqlData({
      sources: {
        nodes: [
          {
            id: SOURCE_ID,
            name: 'Source A',
            displayName: 'Source A (EN)',
            lang: 'en',
            contentWarning: 'SAFE',
            supportsLatest: true,
            extension: { hasUpdate: false, isObsolete: false },
          },
        ],
      },
    })
  );
  return server;
};

const origin = (server?: FakeSuwayomi) => {
  if (!server) {
    return { hostname: '127.0.0.1', port: 4567, useSsl: false, baseUrl: '' };
  }
  const url = new URL(server.url);
  return {
    hostname: url.hostname,
    port: Number(url.port),
    useSsl: false,
    baseUrl: '',
  };
};

const settingsBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Suwayomi',
  ...origin(),
  authMode: 'UI_LOGIN',
  username: USERNAME,
  password: PASSWORD,
  sourceAllowlist: [SOURCE_ID],
  preferredLanguages: ['en'],
  scanlatorPreference: ['Group A'],
  requireCbz: true,
  ...overrides,
});

const storedInstance = (
  overrides: Partial<SuwayomiSettings> = {}
): SuwayomiSettings => ({
  id: 1,
  name: 'Suwayomi',
  ...origin(),
  isDefault: true,
  authMode: 'UI_LOGIN',
  username: USERNAME,
  password: PASSWORD,
  sourceAllowlist: [SOURCE_ID],
  preferredLanguages: ['en'],
  scanlatorPreference: ['Group A'],
  requireCbz: true,
  ...overrides,
});

const view = (instance: SuwayomiSettings) => ({
  ...instance,
  baseUrl: instance.baseUrl ?? '',
  password: instance.password ? REDACTED_SECRET : '',
});

before(() => {
  initI18n();
});

beforeEach(() => {
  const settings = getSettings();
  settings.suwayomi = [];
  invalidateSuwayomiClients();
  mock.method(settings, 'save', async () => undefined);
  responseErrors.length = 0;
});

afterEach(async () => {
  mock.restoreAll();
  getSettings().suwayomi = [];
  invalidateSuwayomiClients();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  assert.deepEqual(responseErrors, []);
});

describe('Suwayomi settings routes', () => {
  it('lists instances without their passwords', async () => {
    const withPassword = storedInstance();
    const withoutPassword = storedInstance({
      id: 2,
      isDefault: false,
      authMode: 'NONE',
      username: '',
      password: '',
    });
    getSettings().suwayomi = [withPassword, withoutPassword];

    const res = await request(createApp()).get(BASE);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [view(withPassword), view(withoutPassword)]);
    assert.ok(!res.text.includes(PASSWORD));
    assert.equal(res.body[0].useSsl, false);
    assert.equal(res.body[0].isDefault, true);
    assert.equal(res.body[0].requireCbz, true);
  });

  it('creates one instance and refuses a second', async () => {
    const app = createApp();

    const created = await request(app).post(BASE).send(settingsBody());

    assert.equal(created.status, 201, inspect(created.body));
    // Service IDs start at 0, as for the other services.
    assert.equal(created.body.id, 0);
    assert.equal(created.body.isDefault, true);
    assert.equal(created.body.password, REDACTED_SECRET);
    assert.ok(!created.text.includes(PASSWORD));
    assert.deepEqual(getSettings().suwayomi, [
      {
        ...storedInstance({ id: 0 }),
        baseUrl: getSettings().suwayomi[0].baseUrl,
      },
    ]);

    const second = await request(app)
      .post(BASE)
      .send(settingsBody({ name: 'Second', port: 4568 }));
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'SUWAYOMI_INSTANCE_LIMIT');
    assert.equal(getSettings().suwayomi.length, 1);
  });

  it('rejects invalid settings with stable codes', async () => {
    const app = createApp();
    const cases: [Record<string, unknown>, number, string?][] = [
      [{ hostname: 'not a host' }, 400, 'SUWAYOMI_INVALID_SETTINGS'],
      [{ port: 0 }, 400, 'SUWAYOMI_INVALID_SETTINGS'],
      [{ sourceAllowlist: ['0'] }, 400, 'SUWAYOMI_INVALID_SETTINGS'],
      [{ username: '', password: '' }, 400, 'SUWAYOMI_CREDENTIALS_REQUIRED'],
      [{ password: REDACTED_SECRET }, 400, 'SUWAYOMI_PASSWORD_REQUIRED'],
      // The server assigns these.
      [{ id: 7 }, 400],
      [{ isDefault: false }, 400],
    ];
    for (const [overrides, status, code] of cases) {
      const res = await request(app).post(BASE).send(settingsBody(overrides));
      assert.equal(res.status, status, inspect(overrides));
      if (code) {
        assert.equal(res.body.code, code, inspect(overrides));
      }
    }
    assert.deepEqual(getSettings().suwayomi, []);
  });

  it('ignores fields it does not know', async () => {
    const res = await request(createApp())
      .post(BASE)
      .send(settingsBody({ apiKey: 'unused', syncEnabled: true }));

    assert.equal(res.status, 201);
    const [stored] = getSettings().suwayomi;
    assert.ok(!('apiKey' in stored));
    assert.ok(!('syncEnabled' in stored));
  });

  it('keeps a redacted password only for the same address and username', async () => {
    const app = createApp();
    getSettings().suwayomi = [storedInstance()];

    const renamed = await request(app)
      .put(`${BASE}/1`)
      .send(settingsBody({ name: 'Renamed', password: REDACTED_SECRET }));
    assert.equal(renamed.status, 200, inspect(renamed.body));
    assert.equal(renamed.body.name, 'Renamed');
    assert.equal(renamed.body.id, 1);
    assert.equal(renamed.body.isDefault, true);
    assert.equal(getSettings().suwayomi[0].password, PASSWORD);

    for (const change of [
      { hostname: '127.0.0.2' },
      { port: 4568 },
      { useSsl: true },
      { baseUrl: '/suwayomi' },
      { username: 'other-user' },
    ]) {
      const res = await request(app)
        .put(`${BASE}/1`)
        .send(settingsBody({ ...change, password: REDACTED_SECRET }));
      assert.equal(res.status, 400, inspect(change));
      assert.equal(res.body.code, 'SUWAYOMI_PASSWORD_REQUIRED');
    }
    assert.equal(getSettings().suwayomi[0].hostname, '127.0.0.1');
    assert.equal(getSettings().suwayomi[0].password, PASSWORD);

    const newPassword = randomUUID();
    const moved = await request(app)
      .put(`${BASE}/1`)
      .send(settingsBody({ hostname: '127.0.0.2', password: newPassword }));
    assert.equal(moved.status, 200);
    assert.equal(getSettings().suwayomi[0].hostname, '127.0.0.2');
    assert.equal(getSettings().suwayomi[0].password, newPassword);
    assert.ok(!moved.text.includes(newPassword));
  });

  it('refuses updates to unknown instances and missing credentials', async () => {
    const app = createApp();
    getSettings().suwayomi = [storedInstance()];

    const unknown = await request(app).put(`${BASE}/2`).send(settingsBody());
    assert.equal(unknown.status, 404);

    const empty = await request(app)
      .put(`${BASE}/1`)
      .send(settingsBody({ username: '', password: '' }));
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'SUWAYOMI_CREDENTIALS_REQUIRED');

    const none = await request(app)
      .put(`${BASE}/1`)
      .send(settingsBody({ authMode: 'NONE', username: '', password: '' }));
    assert.equal(none.status, 200);
    assert.equal(none.body.password, '');
  });

  it('refuses to remove an instance that active manga requests use', async () => {
    const app = createApp();
    getSettings().suwayomi = [storedInstance({ id: 2 })];
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MANGA,
        tmdbId: 0,
        status: MediaStatus.PENDING,
      })
    );
    const active = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MANGA,
        media,
        requestedBy: user,
        status: MediaRequestStatus.PENDING,
        serverId: 2,
        is4k: false,
      })
    );

    const blocked = await request(app).delete(`${BASE}/2`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'SUWAYOMI_IN_USE');
    assert.equal(getSettings().suwayomi.length, 1);

    await getRepository(MediaRequest).update(active.id, {
      status: MediaRequestStatus.COMPLETED,
    });
    const removed = await request(app).delete(`${BASE}/2`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, view(storedInstance({ id: 2 })));
    assert.deepEqual(getSettings().suwayomi, []);

    const missing = await request(app).delete(`${BASE}/2`);
    assert.equal(missing.status, 404);
  });

  it('drops cached clients when an instance changes or is removed', async () => {
    const app = createApp();
    getSettings().suwayomi = [storedInstance()];
    const original = getSuwayomiClient(1);
    assert.ok(original);

    const res = await request(app)
      .put(`${BASE}/1`)
      .send(settingsBody({ name: 'Renamed', password: REDACTED_SECRET }));
    assert.equal(res.status, 200);
    const updated = getSuwayomiClient(1);
    assert.ok(updated);
    assert.notEqual(updated, original);

    assert.equal((await request(app).delete(`${BASE}/1`)).status, 200);
    getSettings().suwayomi = [storedInstance({ name: 'Renamed' })];
    assert.notEqual(getSuwayomiClient(1), updated);
  });

  it('saves and removes instances without contacting Suwayomi', async () => {
    const server = await startFake();
    const app = createApp();

    const created = await request(app)
      .post(BASE)
      .send(settingsBody(origin(server)));
    assert.equal(created.status, 201);
    assert.equal((await request(app).get(BASE)).status, 200);
    const updated = await request(app)
      .put(`${BASE}/${created.body.id}`)
      .send(
        settingsBody({
          ...origin(server),
          name: 'Renamed',
          password: REDACTED_SECRET,
        })
      );
    assert.equal(updated.status, 200);
    assert.equal(
      (await request(app).delete(`${BASE}/${created.body.id}`)).status,
      200
    );

    assert.equal(server.requests.length, 0);
  });

  it('is limited to administrators', async () => {
    const server = await startFake();
    getSettings().suwayomi = [storedInstance(origin(server))];
    const app = createApp(2);

    const responses = [
      await request(app).get(BASE),
      await request(app).post(BASE).send(settingsBody()),
      await request(app)
        .post(`${BASE}/test`)
        .send({ ...origin(server), username: USERNAME, password: PASSWORD }),
      await request(app).put(`${BASE}/1`).send(settingsBody()),
      await request(app).delete(`${BASE}/1`),
    ];

    assert.deepEqual(
      responses.map((res) => res.status),
      [403, 403, 403, 403, 403]
    );
    assert.ok(responses.every((res) => !res.text.includes(PASSWORD)));
    assert.equal(server.requests.length, 0);
    assert.equal(getSettings().suwayomi[0].name, 'Suwayomi');
  });
});

describe('Suwayomi connection test route', () => {
  it('tests submitted settings', async () => {
    const server = await startFake();

    const res = await request(createApp())
      .post(`${BASE}/test`)
      .send({ ...origin(server), username: USERNAME, password: PASSWORD });

    assert.equal(res.status, 200, inspect(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.authMode, 'UI_LOGIN');
    assert.equal(res.body.version, FAKE_VERSION);
    assert.deepEqual(
      res.body.sources.map((source: { id: string }) => source.id),
      [SOURCE_ID]
    );
    assert.equal(server.logins, 1);
    assert.ok(!res.text.includes(PASSWORD));
  });

  it('uses the stored password only for the same address and username', async () => {
    const server = await startFake();
    getSettings().suwayomi = [storedInstance(origin(server))];
    const app = createApp();
    const redacted = {
      id: 1,
      ...origin(server),
      username: USERNAME,
      password: REDACTED_SECRET,
    };

    const res = await request(app).post(`${BASE}/test`).send(redacted);
    assert.equal(res.status, 200, inspect(res.body));
    assert.equal(server.logins, 1);

    const sent = server.requests.length;
    const refused = [
      { ...redacted, id: undefined },
      { ...redacted, id: 2 },
      { ...redacted, port: redacted.port + 1 },
      { ...redacted, hostname: 'localhost' },
      { ...redacted, baseUrl: '/suwayomi' },
      { ...redacted, username: 'other-user' },
    ];
    for (const body of refused) {
      const refusal = await request(app).post(`${BASE}/test`).send(body);
      assert.equal(refusal.status, 400, inspect(body));
      assert.equal(refusal.body.code, 'SUWAYOMI_PASSWORD_REQUIRED');
    }
    assert.equal(server.requests.length, sent);
  });

  it('reports a failed test with a stable code', async () => {
    const server = await startFake();
    const wrongPassword = randomUUID();

    const res = await request(createApp())
      .post(`${BASE}/test`)
      .send({ ...origin(server), username: USERNAME, password: wrongPassword });

    assert.equal(res.status, 502);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'SUWAYOMI_AUTH_FAILED');
    assert.ok(!res.text.includes(wrongPassword));
    assert.ok(!res.text.includes('Incorrect'));

    const invalid = await request(createApp())
      .post(`${BASE}/test`)
      .send({ ...origin(server), port: 0 });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'SUWAYOMI_INVALID_SETTINGS');
  });

  it('stops testing when the admin abandons the request', async () => {
    const server = await startFake();
    let reached!: () => void;
    const capabilitiesReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    server.onOperation('Capabilities', () => {
      reached();
      return { hang: true };
    });
    const listener = createApp().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    try {
      const { port } = listener.address() as AddressInfo;
      const pending = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `${BASE}/test`,
        headers: { 'Content-Type': 'application/json' },
      });
      pending.on('error', () => undefined);
      pending.end(
        JSON.stringify({
          ...origin(server),
          username: USERNAME,
          password: PASSWORD,
        })
      );
      await capabilitiesReached;
      const abandonedAt = Date.now();
      pending.destroy();

      const [hung] = server.operations('Capabilities');
      assert.equal(await hung.closed, false);
      // Well before the client's own call timeout.
      assert.ok(Date.now() - abandonedAt < 5_000);
    } finally {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
  });
});

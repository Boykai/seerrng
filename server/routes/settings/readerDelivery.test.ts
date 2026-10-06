import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import {
  ReaderDeliveryApi,
  ReaderServiceError,
} from '@server/api/readerDelivery';
import { getRepository } from '@server/datasource';
import ReaderDeliveryGrouping from '@server/entity/ReaderDeliveryGrouping';
import { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { Permission } from '@server/lib/permissions';
import {
  defaultReaderDeliverySettings,
  getSettings,
} from '@server/lib/settings';
import serviceRoutes from '@server/routes/service';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import request from 'supertest';

setupTestDb();

const loginArguments = (call: { arguments: unknown }) =>
  call.arguments as Parameters<ReaderDeliveryApi['login']>;

const createApp = (permissions = Permission.ADMIN) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = new User({ id: 1, permissions });
    next();
  });
  app.use('/settings', settingsRoutes);
  app.use('/service', serviceRoutes);
  app.use(
    (
      error: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      void _next;
      return res.status(error.status ?? 500).json({
        status: error.status ?? 500,
        message: error.message,
      });
    }
  );
  return app;
};

before(() => {
  initI18n();
});

beforeEach(async () => {
  await getRepository(ReaderDeliveryGrouping).clear();
  await getSettings().persistSection(
    'readerDelivery',
    defaultReaderDeliverySettings()
  );
});

afterEach(() => {
  mock.restoreAll();
});

describe('reader delivery settings API', () => {
  it('normalizes OPDS and Komga addresses, persists both services, and falls back from Grimmory', async () => {
    const app = createApp();
    await getSettings().persistSection(
      'readerDelivery',
      defaultReaderDeliverySettings()
    );

    const response = await request(app)
      .put('/settings/reader-delivery')
      .send({
        grimmoryUrl: 'https://grimmory.example/reader/komga/api/',
        bookorbitUrl: 'http://bookorbit.example:4040/books/api/v1/opds/',
        preferredProvider: 'grimmory',
      })
      .expect(200);

    assert.deepEqual(response.body, {
      grimmoryUrl: 'https://grimmory.example/reader',
      grimmoryUsername: '',
      grimmoryPassword: '',
      bookorbitUrl: 'http://bookorbit.example:4040/books',
      bookorbitUsername: '',
      bookorbitPassword: '',
      preferredProvider: 'grimmory',
    });

    const preferred = await request(app)
      .get('/service/reader-delivery')
      .expect(200);
    assert.equal(preferred.body.provider, 'grimmory');
    assert.equal(preferred.body.preferredProvider, 'grimmory');
    assert.equal(preferred.body.serviceUrl, 'https://grimmory.example/reader');

    await request(app)
      .put('/settings/reader-delivery')
      .send({ grimmoryUrl: '' })
      .expect(200);
    const fallback = await request(app)
      .get('/service/reader-delivery')
      .expect(200);
    assert.equal(fallback.body.provider, 'bookorbit');
    assert.equal(fallback.body.preferredProvider, 'grimmory');
    assert.equal(
      fallback.body.serviceUrl,
      'http://bookorbit.example:4040/books'
    );
  });

  it('rejects reader URLs with embedded credentials, query strings, or invalid preferences', async () => {
    const app = createApp();
    await getSettings().persistSection(
      'readerDelivery',
      defaultReaderDeliverySettings()
    );

    await request(app)
      .put('/settings/reader-delivery')
      .send({
        grimmoryUrl: 'https://reader:secret@grimmory.example',
        preferredProvider: 'grimmory',
      })
      .expect(400);

    await request(app)
      .put('/settings/reader-delivery')
      .send({
        bookorbitUrl: 'https://bookorbit.example?token=secret',
        preferredProvider: 'bookorbit',
      })
      .expect(400);

    await request(app)
      .put('/settings/reader-delivery')
      .send({
        grimmoryUrl: 'https://grimmory.example',
        preferredProvider: 'other',
      })
      .expect(400);
  });

  it('requires administrator permission to save reader settings', async () => {
    await getRepository(User).update(1, { permissions: Permission.REQUEST });

    await request(createApp(Permission.REQUEST))
      .put('/settings/reader-delivery')
      .send({
        grimmoryUrl: 'https://grimmory.example',
        preferredProvider: 'grimmory',
      })
      .expect(403);
  });

  it('redacts saved provider passwords and preserves them when settings are edited', async () => {
    const app = createApp();
    const saved = await request(app)
      .put('/settings/reader-delivery')
      .send({
        grimmoryUrl: 'https://grimmory.example',
        grimmoryUsername: 'shelf-admin',
        grimmoryPassword: 'grimmory-secret',
        bookorbitUrl: 'https://bookorbit.example',
        bookorbitUsername: 'orbit-admin',
        bookorbitPassword: 'bookorbit-secret',
        preferredProvider: 'grimmory',
      })
      .expect(200);

    assert.equal(saved.body.grimmoryPassword, '[REDACTED]');
    assert.equal(saved.body.bookorbitPassword, '[REDACTED]');
    assert.equal(
      getSettings().readerDelivery.grimmoryPassword,
      'grimmory-secret'
    );
    assert.equal(
      getSettings().readerDelivery.bookorbitPassword,
      'bookorbit-secret'
    );

    await request(app)
      .put('/settings/reader-delivery')
      .send({ ...saved.body, preferredProvider: 'bookorbit' })
      .expect(200);
    const loaded = await request(app)
      .get('/settings/reader-delivery')
      .expect(200);
    assert.equal(loaded.body.grimmoryPassword, '[REDACTED]');
    assert.equal(loaded.body.bookorbitPassword, '[REDACTED]');
    assert.equal(
      getSettings().readerDelivery.grimmoryPassword,
      'grimmory-secret'
    );
    assert.equal(
      getSettings().readerDelivery.bookorbitPassword,
      'bookorbit-secret'
    );
  });

  it('keeps a saved password on save only for the same address and username', async () => {
    const app = createApp();
    await getSettings().persistSection('readerDelivery', {
      ...defaultReaderDeliverySettings(),
      grimmoryUrl: 'https://grimmory.example',
      grimmoryUsername: 'shelf-admin',
      grimmoryPassword: 'grimmory-secret',
      bookorbitUrl: 'https://bookorbit.example',
      bookorbitUsername: 'orbit-admin',
      bookorbitPassword: 'bookorbit-secret',
      preferredProvider: 'grimmory',
    });

    await request(app)
      .put('/settings/reader-delivery')
      .send({
        grimmoryUrl: 'https://grimmory.example/komga/api',
        grimmoryUsername: 'shelf-admin',
        grimmoryPassword: '',
      })
      .expect(200);
    assert.equal(
      getSettings().readerDelivery.grimmoryPassword,
      'grimmory-secret'
    );

    const changedAddress = await request(app)
      .put('/settings/reader-delivery')
      .send({
        grimmoryUrl: 'https://other-grimmory.example',
        grimmoryUsername: 'shelf-admin',
        grimmoryPassword: '[REDACTED]',
        preferredProvider: 'bookorbit',
      })
      .expect(400);
    assert.equal(
      changedAddress.body.error,
      'Enter the Grimmory password again to save a changed address or username.'
    );
    const changedUsername = await request(app)
      .put('/settings/reader-delivery')
      .send({ bookorbitUsername: 'other-admin' })
      .expect(400);
    assert.equal(
      changedUsername.body.error,
      'Enter the BookOrbit password again to save a changed address or username.'
    );
    assert.deepEqual(getSettings().readerDelivery, {
      grimmoryUrl: 'https://grimmory.example',
      grimmoryUsername: 'shelf-admin',
      grimmoryPassword: 'grimmory-secret',
      bookorbitUrl: 'https://bookorbit.example',
      bookorbitUsername: 'orbit-admin',
      bookorbitPassword: 'bookorbit-secret',
      preferredProvider: 'grimmory',
    });

    await request(app)
      .put('/settings/reader-delivery')
      .send({
        grimmoryUrl: 'https://other-grimmory.example',
        grimmoryPassword: 'new-grimmory-secret',
      })
      .expect(200);
    assert.equal(
      getSettings().readerDelivery.grimmoryUrl,
      'https://other-grimmory.example'
    );
    assert.equal(
      getSettings().readerDelivery.grimmoryPassword,
      'new-grimmory-secret'
    );

    await request(app)
      .put('/settings/reader-delivery')
      .send({ bookorbitUsername: '' })
      .expect(200);
    assert.equal(getSettings().readerDelivery.bookorbitUsername, '');
    assert.equal(getSettings().readerDelivery.bookorbitPassword, '');

    await request(app)
      .put('/settings/reader-delivery')
      .send({
        grimmoryUsername: 'shelf-admin',
        grimmoryPassword: '[REDACTED]',
        clearGrimmoryCredentials: true,
      })
      .expect(200);
    assert.equal(getSettings().readerDelivery.grimmoryUsername, '');
    assert.equal(getSettings().readerDelivery.grimmoryPassword, '');
  });

  it('tests provider account access by logging in and listing manageable groupings', async () => {
    const app = createApp();
    await getSettings().persistSection('readerDelivery', {
      ...defaultReaderDeliverySettings(),
      grimmoryUrl: 'https://grimmory.example',
      grimmoryUsername: 'admin',
      grimmoryPassword: 'password',
    });
    mock.method(
      ReaderDeliveryApi.prototype,
      'login',
      async () => 'reader-token'
    );
    mock.method(ReaderDeliveryApi.prototype, 'listGroupings', async () => [
      { id: 1, name: 'One' },
      { id: 2, name: 'Two' },
    ]);

    const response = await request(app)
      .post('/settings/reader-delivery/connection-test')
      .send({ provider: 'grimmory' })
      .expect(200);
    assert.deepEqual(response.body, {
      connected: true,
      provider: 'grimmory',
      existingGroupingCount: 2,
    });
  });

  it('tests unsaved BookOrbit values with the address, username, and password from the form', async () => {
    const app = createApp();
    const login = mock.method(
      ReaderDeliveryApi.prototype,
      'login',
      async () => 'reader-token'
    );
    const list = mock.method(
      ReaderDeliveryApi.prototype,
      'listGroupings',
      async () => [{ id: 1, name: 'One' }]
    );

    const response = await request(app)
      .post('/settings/reader-delivery/connection-test')
      .send({
        provider: 'bookorbit',
        url: ' https://bookorbit.example.test/api/v1/opds/ ',
        username: ' scope-owner ',
        password: ' typed password ',
      })
      .expect(200);

    assert.deepEqual(response.body, {
      connected: true,
      provider: 'bookorbit',
      existingGroupingCount: 1,
    });
    const [provider, credentials] = loginArguments(login.mock.calls[0]);
    assert.equal(provider, 'bookorbit');
    assert.deepEqual(credentials, {
      url: 'https://bookorbit.example.test',
      username: 'scope-owner',
      password: ' typed password ',
    });
    const [, token] = list.mock.calls[0].arguments as unknown as Parameters<
      ReaderDeliveryApi['listGroupings']
    >;
    assert.equal(token, 'reader-token');
    assert.equal(getSettings().readerDelivery.bookorbitUrl, '');
  });

  it('reuses a saved password only for the saved address and username', async () => {
    const app = createApp();
    await getSettings().persistSection('readerDelivery', {
      ...defaultReaderDeliverySettings(),
      bookorbitUrl: 'https://bookorbit.example.test',
      bookorbitUsername: 'scope-owner',
      bookorbitPassword: 'saved-password',
    });
    const login = mock.method(
      ReaderDeliveryApi.prototype,
      'login',
      async () => 'reader-token'
    );
    mock.method(ReaderDeliveryApi.prototype, 'listGroupings', async () => []);
    const saved = {
      provider: 'bookorbit',
      url: 'https://BookOrbit.example.test/',
      username: 'scope-owner',
    };

    for (const password of ['', '[REDACTED]', undefined]) {
      await request(app)
        .post('/settings/reader-delivery/connection-test')
        .send({ ...saved, password })
        .expect(200);
    }
    assert.equal(login.mock.callCount(), 3);
    for (const call of login.mock.calls) {
      assert.equal(loginArguments(call)[1].password, 'saved-password');
    }

    for (const changed of [
      { url: 'https://other-reader.example.test' },
      { url: 'https://bookorbit.example.test/reader' },
      { username: 'another-account' },
    ]) {
      const refused = await request(app)
        .post('/settings/reader-delivery/connection-test')
        .send({ ...saved, ...changed, password: '[REDACTED]' })
        .expect(400);
      assert.equal(
        refused.body.error,
        'Enter the BookOrbit password again to test a changed address or username.'
      );
    }
    assert.equal(login.mock.callCount(), 3);
  });

  it('asks for the missing address, username, or password before testing', async () => {
    const app = createApp();
    const login = mock.method(
      ReaderDeliveryApi.prototype,
      'login',
      async () => 'reader-token'
    );

    const cases: [Record<string, unknown>, string][] = [
      [
        { url: '', username: 'admin', password: 'secret' },
        'Enter the Grimmory address to test the connection.',
      ],
      [
        { url: 'https://grimmory.example.test', username: ' ', password: 's' },
        'Enter the Grimmory username to test the connection.',
      ],
      [
        { url: 'https://grimmory.example.test', username: 'admin' },
        'Enter the Grimmory password to test the connection.',
      ],
      [
        {
          url: 'https://grimmory.example.test/?token=secret',
          username: 'admin',
          password: 'secret',
        },
        'Grimmory URL must be an HTTP or HTTPS URL without credentials, query parameters, or a fragment.',
      ],
    ];
    for (const [fields, error] of cases) {
      const response = await request(app)
        .post('/settings/reader-delivery/connection-test')
        .send({ provider: 'grimmory', ...fields })
        .expect(400);
      assert.equal(response.body.error, error);
    }
    assert.equal(login.mock.callCount(), 0);
  });

  it('names the failed step with advice and without service text', async () => {
    const app = createApp();
    const body = {
      provider: 'bookorbit',
      url: 'https://bookorbit.example.test',
      username: 'scope-owner',
      password: 'typed-password',
    };
    const cases: ['login' | 'listGroupings', ReaderServiceError, RegExp][] = [
      [
        'login',
        new ReaderServiceError('sign-in', 'not-api'),
        /^Signing in to BookOrbit failed\. The address did not answer like the BookOrbit API\. .*base-path/,
      ],
      [
        'login',
        new ReaderServiceError('sign-in', 'http', { status: 401 }),
        /^Signing in to BookOrbit failed\. BookOrbit did not accept the username and password\./,
      ],
      [
        'login',
        new ReaderServiceError('sign-in', 'network', { code: 'ECONNABORTED' }),
        /^Signing in to BookOrbit failed\. BookOrbit did not answer in time\./,
      ],
      [
        'login',
        new ReaderServiceError('sign-in', 'network', { code: 'ECONNREFUSED' }),
        /^Signing in to BookOrbit failed\. SeerrNG could not reach BookOrbit\./,
      ],
      [
        'listGroupings',
        new ReaderServiceError('list', 'http', { status: 403 }),
        /^Listing BookOrbit Smart Scopes failed\. BookOrbit refused this account access to Smart Scopes\./,
      ],
      [
        'listGroupings',
        new ReaderServiceError('list', 'unexpected'),
        /^Listing BookOrbit Smart Scopes failed\. BookOrbit sent a response SeerrNG does not recognize\./,
      ],
      [
        'listGroupings',
        new ReaderServiceError('list', 'http', { status: 404 }),
        /^Listing BookOrbit Smart Scopes failed\. BookOrbit does not offer the Smart Scope API at this address\./,
      ],
    ];

    for (const [method, error, message] of cases) {
      mock.restoreAll();
      mock.method(ReaderDeliveryApi.prototype, 'login', async () =>
        method === 'login' ? Promise.reject(error) : 'reader-token'
      );
      mock.method(ReaderDeliveryApi.prototype, 'listGroupings', async () =>
        Promise.reject(error)
      );
      const response = await request(app)
        .post('/settings/reader-delivery/connection-test')
        .send(body)
        .expect(502);
      assert.match(response.body.error, message);
      assert.doesNotMatch(response.body.error, /typed-password|scope-owner/);
    }

    mock.restoreAll();
    mock.method(ReaderDeliveryApi.prototype, 'login', async () => {
      throw new Error('upstream detail with typed-password');
    });
    const unknown = await request(app)
      .post('/settings/reader-delivery/connection-test')
      .send({ ...body, provider: 'grimmory' })
      .expect(502);
    assert.equal(
      unknown.body.error,
      'SeerrNG could not complete the request to Grimmory. Check the service address and try again.'
    );
  });

  it('removes a mapping whose shelf the service already deleted, but not after a failed sign-in', async () => {
    const app = createApp();
    await getSettings().persistSection('readerDelivery', {
      ...defaultReaderDeliverySettings(),
      grimmoryUrl: 'https://grimmory.example.test',
      grimmoryUsername: 'admin',
      grimmoryPassword: 'password',
    });
    const repository = getRepository(ReaderDeliveryGrouping);
    const grouping = await repository.save(
      repository.create({
        provider: 'grimmory',
        targetType: 'author',
        targetId: 'author-7',
        targetName: 'Invented Author',
        groupName: 'SeerrNG · Author · Invented Author [abcdef123456]',
        remoteGroupId: '7',
        isPublic: true,
        syncToKobo: false,
        status: 'ready',
        lastError: null,
      })
    );

    mock.method(ReaderDeliveryApi.prototype, 'login', async () => {
      throw new ReaderServiceError('sign-in', 'http', { status: 404 });
    });
    const refused = await request(app)
      .delete('/settings/reader-delivery/groupings/' + grouping.id)
      .expect(502);
    assert.match(refused.body.error, /^Signing in to Grimmory failed\./);
    assert.equal(await repository.count(), 1);

    mock.restoreAll();
    mock.method(
      ReaderDeliveryApi.prototype,
      'login',
      async () => 'reader-token'
    );
    mock.method(ReaderDeliveryApi.prototype, 'deleteGrouping', async () => {
      throw new ReaderServiceError('delete', 'http', { status: 404 });
    });
    await request(app)
      .delete('/settings/reader-delivery/groupings/' + grouping.id)
      .expect(200);
    assert.equal(await repository.count(), 0);
  });

  it('previews and upserts only a SeerrNG-managed grouping, then confirms its provider count', async () => {
    const app = createApp();
    await getSettings().persistSection('readerDelivery', {
      ...defaultReaderDeliverySettings(),
      grimmoryUrl: 'https://grimmory.example',
      grimmoryUsername: 'admin',
      grimmoryPassword: 'password',
    });
    mock.method(
      ReaderDeliveryApi.prototype,
      'login',
      async () => 'reader-token'
    );
    mock.method(ReaderDeliveryApi.prototype, 'preview', async () => ({
      matchedCount: 2,
      sampleTitles: ['A Wizard of Earthsea', 'The Tombs of Atuan'],
    }));
    const findManaged = mock.method(
      ReaderDeliveryApi.prototype,
      'findGroupingIdByName',
      async () => undefined
    );
    const saveManaged = mock.method(
      ReaderDeliveryApi.prototype,
      'saveGrouping',
      async (
        _provider: 'grimmory' | 'bookorbit',
        _token: string,
        group: Parameters<ReaderDeliveryApi['saveGrouping']>[2]
      ) => group.id ?? '47'
    );
    mock.method(ReaderDeliveryApi.prototype, 'getGroupingCount', async () => 2);
    const target = {
      type: 'book-series',
      id: 'bookshelf:series-42',
      name: 'Earthsea',
    };

    const preview = await request(app)
      .post('/settings/reader-delivery/groupings/preview')
      .send({ provider: 'grimmory', target })
      .expect(200);
    assert.equal(preview.body.matchedCount, 2);
    assert.equal(preview.body.ruleSummary, 'Book series: Earthsea');

    const created = await request(app)
      .post('/settings/reader-delivery/groupings')
      .send({ provider: 'grimmory', target, isPublic: true })
      .expect(200);
    assert.equal(created.body.grouping.remoteGroupId, '47');
    assert.equal(created.body.grouping.lastMatchCount, 2);
    assert.equal(created.body.grouping.countVerified, true);
    assert.equal(created.body.grouping.status, 'ready');
    assert.equal(findManaged.mock.callCount(), 1);
    assert.equal(saveManaged.mock.callCount(), 1);

    const updated = await request(app)
      .post('/settings/reader-delivery/groupings')
      .send({ provider: 'grimmory', target, isPublic: false })
      .expect(200);
    assert.equal(updated.body.grouping.remoteGroupId, '47');
    assert.equal(updated.body.grouping.isPublic, false);
    assert.equal(saveManaged.mock.callCount(), 2);
    assert.equal(saveManaged.mock.calls[1].arguments[2].id, '47');

    const managed = await request(app)
      .get('/settings/reader-delivery/groupings')
      .expect(200);
    assert.equal(managed.body.length, 1);
    assert.equal(managed.body[0].targetName, 'Earthsea');
    assert.equal(managed.body[0].remoteGroupId, '47');
  });

  it('keeps provider shelf names within the provider 255-character limit', async () => {
    const app = createApp();
    await getSettings().persistSection('readerDelivery', {
      ...defaultReaderDeliverySettings(),
      grimmoryUrl: 'https://grimmory.example',
      grimmoryUsername: 'admin',
      grimmoryPassword: 'password',
    });
    mock.method(
      ReaderDeliveryApi.prototype,
      'login',
      async () => 'reader-token'
    );
    mock.method(ReaderDeliveryApi.prototype, 'preview', async () => ({
      matchedCount: 1,
      sampleTitles: ['One Book'],
    }));
    mock.method(
      ReaderDeliveryApi.prototype,
      'findGroupingIdByName',
      async () => undefined
    );
    const saveManaged = mock.method(
      ReaderDeliveryApi.prototype,
      'saveGrouping',
      async () => 'long-name-shelf'
    );
    mock.method(ReaderDeliveryApi.prototype, 'getGroupingCount', async () => 1);

    await request(app)
      .post('/settings/reader-delivery/groupings')
      .send({
        provider: 'grimmory',
        target: {
          type: 'author',
          id: 'author-with-long-display-name',
          name: 'A'.repeat(255),
        },
      })
      .expect(200);

    const savedCall = saveManaged.mock.calls.at(0);
    assert.ok(savedCall);
    const savedGroup = savedCall.arguments[2];
    assert.ok(savedGroup);
    const savedName = savedGroup.name;
    assert.ok(savedName.length <= 255);
    assert.match(savedName, /\[[0-9a-f]{12}\]$/);
  });

  it('recovers a previously created remote shelf by its SeerrNG mapping name', async () => {
    const app = createApp();
    await getSettings().persistSection('readerDelivery', {
      ...defaultReaderDeliverySettings(),
      grimmoryUrl: 'https://grimmory.example',
      grimmoryUsername: 'admin',
      grimmoryPassword: 'password',
    });
    const repository = getRepository(ReaderDeliveryGrouping);
    await repository.save(
      repository.create({
        provider: 'grimmory',
        targetType: 'book-series',
        targetId: 'series-recovery-42',
        targetName: 'Recovered Series',
        groupName: 'SeerrNG · Book Series · Recovered Series [recovery]',
        remoteGroupId: null,
        isPublic: true,
        syncToKobo: false,
        status: 'error',
        lastError: 'The previous response was interrupted.',
      })
    );
    mock.method(
      ReaderDeliveryApi.prototype,
      'login',
      async () => 'reader-token'
    );
    mock.method(ReaderDeliveryApi.prototype, 'preview', async () => ({
      matchedCount: 1,
      sampleTitles: ['Recovered Book'],
    }));
    const findManaged = mock.method(
      ReaderDeliveryApi.prototype,
      'findGroupingIdByName',
      async () => 'remote-shelf-42'
    );
    const saveManaged = mock.method(
      ReaderDeliveryApi.prototype,
      'saveGrouping',
      async (
        _provider: 'grimmory' | 'bookorbit',
        _token: string,
        group: Parameters<ReaderDeliveryApi['saveGrouping']>[2]
      ) => group.id ?? 'remote-shelf-42'
    );
    mock.method(ReaderDeliveryApi.prototype, 'getGroupingCount', async () => 1);

    const response = await request(app)
      .post('/settings/reader-delivery/groupings')
      .send({
        provider: 'grimmory',
        target: {
          type: 'book-series',
          id: 'series-recovery-42',
          name: 'Recovered Series',
        },
      })
      .expect(200);

    assert.equal(findManaged.mock.callCount(), 1);
    assert.equal(saveManaged.mock.calls[0].arguments[2].id, 'remote-shelf-42');
    assert.equal(response.body.grouping.remoteGroupId, 'remote-shelf-42');
    assert.equal(response.body.grouping.status, 'ready');
  });

  it('requires explicit consent before creating a zero-match future-facing rule', async () => {
    const app = createApp();
    await getSettings().persistSection('readerDelivery', {
      ...defaultReaderDeliverySettings(),
      bookorbitUrl: 'https://bookorbit.example',
      bookorbitUsername: 'admin',
      bookorbitPassword: 'password',
    });
    mock.method(
      ReaderDeliveryApi.prototype,
      'login',
      async () => 'reader-token'
    );
    mock.method(ReaderDeliveryApi.prototype, 'preview', async () => ({
      matchedCount: 0,
      sampleTitles: [],
    }));
    mock.method(
      ReaderDeliveryApi.prototype,
      'findGroupingIdByName',
      async () => undefined
    );
    mock.method(
      ReaderDeliveryApi.prototype,
      'saveGrouping',
      async () => 'scope-9'
    );
    mock.method(ReaderDeliveryApi.prototype, 'getGroupingCount', async () => 0);
    const body = {
      provider: 'bookorbit',
      target: { type: 'book-series', id: 'series:9', name: 'No Books Yet' },
      isPublic: true,
    };

    const refused = await request(app)
      .post('/settings/reader-delivery/groupings')
      .send(body)
      .expect(409);
    assert.equal(refused.body.code, 'empty-match');
    assert.equal(await getRepository(ReaderDeliveryGrouping).count(), 0);

    const allowed = await request(app)
      .post('/settings/reader-delivery/groupings')
      .send({ ...body, allowEmpty: true })
      .expect(200);
    assert.equal(allowed.body.grouping.lastMatchCount, 0);
    assert.equal(allowed.body.grouping.countVerified, true);
  });

  it('does not let ordinary users manage reader service credentials or groupings', async () => {
    await getRepository(User).update(1, { permissions: Permission.REQUEST });
    const app = createApp(Permission.REQUEST);
    await request(app)
      .post('/settings/reader-delivery/groupings/preview')
      .send({
        provider: 'grimmory',
        target: { type: 'author', id: '1', name: 'A' },
      })
      .expect(403);
    await request(app)
      .post('/settings/reader-delivery/connection-test')
      .send({ provider: 'grimmory' })
      .expect(403);
  });
});

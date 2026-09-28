import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import ProwlarrAPI from '@server/api/prowlarr';
import { defaultProwlarrCategoryMappings } from '@server/constants/prowlarr';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import indexerSearchRoutes from './indexerSearch';
import prowlarrSettingsRoutes from './settings/prowlarr';

const getOriginalSettings = () => structuredClone(getSettings().prowlarr);
let originalSettings = getOriginalSettings();

function createValidatedApp(permission = Permission.MANAGE_REQUESTS): Express {
  const app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use((req, _res, next) => {
    req.user = new User({ id: 1, permissions: permission });
    next();
  });
  app.use(
    '/api/v1/indexer-search',
    rateLimit({ windowMs: 60_000, limit: 10_000 }),
    isAuthenticated(Permission.MANAGE_REQUESTS),
    indexerSearchRoutes
  );
  app.use(
    (
      error: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) =>
      res.status(error.status ?? 500).json({
        status: error.status ?? 500,
        message: error.message,
      })
  );
  return app;
}

function createValidatedSettingsApp(permission = Permission.ADMIN): Express {
  const app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use((req, _res, next) => {
    req.user = new User({ id: 1, permissions: permission });
    next();
  });
  app.use(
    '/api/v1/settings/prowlarr',
    rateLimit({ windowMs: 60_000, limit: 10_000 }),
    isAuthenticated(Permission.ADMIN),
    prowlarrSettingsRoutes
  );
  app.use(
    (
      error: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) =>
      res.status(error.status ?? 500).json({
        status: error.status ?? 500,
        message: error.message,
      })
  );
  return app;
}

describe('Prowlarr manual search routes', () => {
  beforeEach(() => {
    originalSettings = getOriginalSettings();
    getSettings().prowlarr = {
      hostname: 'prowlarr.local',
      port: 9696,
      useSsl: false,
      baseUrl: '',
      apiKey: 'test-prowlarr-key',
      categoryMappings: defaultProwlarrCategoryMappings(),
    };
  });

  afterEach(() => {
    getSettings().prowlarr = originalSettings;
    mock.restoreAll();
  });

  it('returns sanitized search results through the OpenAPI contract', async () => {
    let received: unknown[] = [];
    mock.method(
      ProwlarrAPI.prototype,
      'search',
      async (
        query: string,
        categories: number[],
        limit: number,
        offset: number
      ) => {
        received = [query, categories, limit, offset];
        return [
          {
            title: 'Dune (2021) 1080p',
            indexer: 'Example indexer',
            protocol: 'Torrent',
            infoUrl:
              'https://tracker.example/details.php?id=91&api_key=private',
            downloadUrl: 'https://tracker.example/download/secret',
            magnetUrl: 'magnet:?xt=secret',
          },
        ];
      }
    );

    const app = createValidatedApp();
    const configuration = await request(app).get(
      '/api/v1/indexer-search/configuration'
    );
    assert.equal(configuration.status, 200);
    assert.equal(configuration.body.configured, true);
    assert.deepEqual(
      configuration.body.categories.find(
        (item: { category: string }) => item.category === 'ebook'
      )?.categoryIds,
      [7020]
    );

    const response = await request(app)
      .post('/api/v1/indexer-search/search')
      .send({ category: 'ebook', query: 'Dune' });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(received, ['Dune', [7020], 50, 0]);
    assert.equal(
      response.body.results[0].infoUrl,
      'https://tracker.example/details.php?id=91'
    );
    assert.equal('downloadUrl' in response.body.results[0], false);
    assert.equal('magnetUrl' in response.body.results[0], false);
    assert.equal(response.body.hasMore, false);
  });

  it('rejects unsupported paging offsets before contacting Prowlarr', async () => {
    const search = mock.method(ProwlarrAPI.prototype, 'search', async () => []);

    const response = await request(createValidatedApp())
      .post('/api/v1/indexer-search/search')
      .send({ category: 'movie', query: 'Dune', offset: 1 });

    assert.equal(response.status, 400);
    assert.equal(search.mock.callCount(), 0);
  });

  it('reports an unconfigured Prowlarr instance without exposing settings', async () => {
    getSettings().prowlarr = {
      ...getSettings().prowlarr,
      hostname: '',
      apiKey: '',
    };

    const response = await request(createValidatedApp())
      .post('/api/v1/indexer-search/search')
      .send({ category: 'movie', query: 'Dune' });

    assert.equal(response.status, 409);
    assert.match(response.body.error, /not configured/);
    assert.equal(
      JSON.stringify(response.body).includes('test-prowlarr-key'),
      false
    );
  });

  it('hides upstream error details from manual search users', async () => {
    mock.method(ProwlarrAPI.prototype, 'search', async () => {
      throw new Error('upstream failed with test-prowlarr-key');
    });

    const response = await request(createValidatedApp())
      .post('/api/v1/indexer-search/search')
      .send({ category: 'movie', query: 'Dune' });

    assert.equal(response.status, 502);
    assert.equal(
      JSON.stringify(response.body).includes('test-prowlarr-key'),
      false
    );
  });

  it('requires Manage Requests permission to view search configuration', async () => {
    const response = await request(createValidatedApp(Permission.REQUEST)).get(
      '/api/v1/indexer-search/configuration'
    );

    assert.equal(response.status, 403);
  });

  it('redacts the saved Prowlarr API key from administrator settings', async () => {
    const response = await request(createValidatedSettingsApp()).get(
      '/api/v1/settings/prowlarr'
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.apiKeyConfigured, true);
    assert.notEqual(response.body.apiKey, 'test-prowlarr-key');
    assert.equal(
      JSON.stringify(response.body).includes('test-prowlarr-key'),
      false
    );
  });

  it('omits private indexer names from coverage summaries', async () => {
    mock.method(ProwlarrAPI.prototype, 'getSystemStatus', async () => ({
      version: '2.4.0',
    }));
    mock.method(ProwlarrAPI.prototype, 'getIndexers', async () => [
      {
        id: 1,
        name: 'Private tracker name',
        enable: true,
        supportsSearch: true,
        protocol: 'torrent',
        capabilities: { categories: [{ id: 2000, name: 'Movies' }] },
      },
    ]);

    const response = await request(createValidatedSettingsApp()).get(
      '/api/v1/settings/prowlarr/coverage'
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.totalIndexers, 1);
    assert.equal('indexers' in response.body, false);
    assert.equal(
      JSON.stringify(response.body).includes('Private tracker name'),
      false
    );
  });

  it('requires administrator permission to read Prowlarr settings', async () => {
    const response = await request(
      createValidatedSettingsApp(Permission.MANAGE_REQUESTS)
    ).get('/api/v1/settings/prowlarr');

    assert.equal(response.status, 403);
  });
});

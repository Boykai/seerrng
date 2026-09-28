import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import ProwlarrAPI, {
  type ProwlarrIndexerResource,
} from '@server/api/prowlarr';
import { MEDIA_CATEGORY_KEYS } from '@server/constants/mediaCategories';
import {
  defaultProwlarrCategoryMappings,
  PROWLARR_SEARCH_TYPE_BY_CATEGORY,
} from '@server/constants/prowlarr';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import indexerSearchRoutes from './indexerSearch';
import prowlarrSettingsRoutes from './settings/prowlarr';

setupTestDb();

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
        offset: number,
        type: string
      ) => {
        received = [query, categories, limit, offset, type];
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
    assert.deepEqual(received, [
      'Dune',
      [7020],
      50,
      0,
      PROWLARR_SEARCH_TYPE_BY_CATEGORY.ebook,
    ]);
    assert.equal(
      response.body.results[0].infoUrl,
      'https://tracker.example/details.php?id=91'
    );
    assert.equal('downloadUrl' in response.body.results[0], false);
    assert.equal('magnetUrl' in response.body.results[0], false);
    assert.equal(response.body.hasMore, false);
  });

  it('selects a format-aware Prowlarr search type for every media category', async () => {
    const received: string[] = [];
    mock.method(
      ProwlarrAPI.prototype,
      'search',
      async (
        _query: string,
        _categories: number[],
        _limit: number,
        _offset: number,
        type: string
      ) => {
        received.push(type);
        return [];
      }
    );

    const app = createValidatedApp();
    for (const category of MEDIA_CATEGORY_KEYS) {
      const response = await request(app)
        .post('/api/v1/indexer-search/search')
        .send({ category, query: 'Example title' });
      assert.equal(
        response.status,
        200,
        `${category}: ${JSON.stringify(response.body)}`
      );
    }

    assert.deepEqual(
      received,
      MEDIA_CATEGORY_KEYS.map(
        (category) => PROWLARR_SEARCH_TYPE_BY_CATEGORY[category]
      )
    );
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

  it('tests enabled searchable indexers with bounded concurrency and redacted failures', async () => {
    await getRepository(User).save(
      new User({ id: 1, permissions: Permission.ADMIN })
    );
    const getIndexers = mock.method(
      ProwlarrAPI.prototype,
      'getIndexers',
      async () => {
        const indexers: ProwlarrIndexerResource[] = [
          ...[1, 2, 3, 4, 5, 6].map((id) => ({
            id,
            name: `Indexer ${id}`,
            enable: true,
            supportsSearch: true,
            capabilities: { categories: [{ id: 2000, name: 'Movies' }] },
          })),
          {
            id: 7,
            name: 'Disabled indexer',
            enable: false,
            supportsSearch: true,
            capabilities: { categories: [] },
          },
          {
            id: 8,
            name: 'RSS only indexer',
            enable: true,
            supportsSearch: false,
            capabilities: { categories: [] },
          },
          {
            id: 9,
            name: 'Indexer with unknown state',
            capabilities: { categories: [] },
          },
        ];
        return indexers;
      }
    );
    mock.method(ProwlarrAPI.prototype, 'getSystemStatus', async () => ({
      version: '2.4.0',
    }));
    const providerCalls: string[] = [];
    mock.method(ProwlarrAPI.prototype, 'getIndexerStatuses', async () => {
      providerCalls.push('statuses');
      return [
        {
          id: 1,
          disabledTill: '2030-01-02T03:04:05Z',
          mostRecentFailure: '2026-09-28T03:04:05Z',
        },
        { indexerId: 2, disabledTill: '2020-01-02T03:04:05Z' },
        { id: 3, disabledTill: 'not a date' },
      ];
    });

    let active = 0;
    let maximumActive = 0;
    const tested: number[] = [];
    mock.method(
      ProwlarrAPI.prototype,
      'testIndexer',
      async (indexer: { id?: number }) => {
        providerCalls.push(`test:${indexer.id}`);
        tested.push(indexer.id!);
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (indexer.id === 2) {
          throw Object.assign(new Error('private upstream detail'), {
            response: {
              status: 401,
              data: 'https://tracker/?passkey=very-secret&token=also-secret',
            },
          });
        }
        return '{}';
      }
    );

    const response = await request(createValidatedSettingsApp())
      .post('/api/v1/settings/prowlarr/test')
      .send({
        hostname: 'prowlarr.local',
        port: 9696,
        useSsl: false,
        apiKey: 'test-prowlarr-key',
        categoryMappings: defaultProwlarrCategoryMappings(),
      });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(getIndexers.mock.callCount(), 1);
    assert.deepEqual(
      tested.sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6]
    );
    assert.equal(providerCalls.at(-1), 'statuses');
    assert.equal(maximumActive, 4);
    assert.equal(response.body.diagnostics.length, 6);
    assert.equal(
      response.body.diagnostics.find((row: { id: number }) => row.id === 1)
        .disabledTill,
      '2030-01-02T03:04:05.000Z'
    );
    assert.equal(
      response.body.diagnostics.find((row: { id: number }) => row.id === 1)
        .mostRecentFailure,
      '2026-09-28T03:04:05.000Z'
    );
    const failed = response.body.diagnostics.find(
      (row: { id: number }) => row.id === 2
    );
    assert.equal(failed.success, false);
    assert.equal(failed.status, 401);
    assert.equal(failed.disabledTill, null);
    assert.equal(
      response.body.diagnostics.find((row: { id: number }) => row.id === 3)
        .disabledTill,
      null
    );
    assert.equal(JSON.stringify(response.body).includes('very-secret'), false);
    assert.equal(JSON.stringify(response.body).includes('also-secret'), false);
    assert.equal(
      JSON.stringify(response.body).includes('private upstream'),
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

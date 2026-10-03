import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';

import {
  bindByMangaId,
  bindBySource,
  resolveDetailKey,
  resolveListKey,
  searchBody,
  selectBody,
  type BindResult,
} from './requestBodies';

const createValidatedApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.get('/api/v1/manga/resolve', (_req, res) => res.status(200).json({}));
  app.get('/api/v1/manga/resolve/:anilistId', (_req, res) =>
    res.status(200).json({})
  );
  app.post('/api/v1/manga/resolve/:anilistId/search', (_req, res) =>
    res.status(202).json({})
  );
  app.post('/api/v1/manga/resolve/:anilistId/select', (_req, res) =>
    res.status(200).json({})
  );
  app.post('/api/v1/manga/resolve/:anilistId/bind', (_req, res) =>
    res.status(200).json({})
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
};

const accepted = (result: BindResult) => {
  assert.ok(result.body, `the client accepts the bind (${result.problem})`);
  return result.body;
};

describe('manga source requests behind the OpenAPI validator', () => {
  const app = createValidatedApp();

  it('accepts every list query the page sends', async () => {
    for (const key of [
      resolveListKey(1, 10),
      resolveListKey(3, 50, 'AWAITING_APPROVAL'),
      resolveListKey(2, 25, 'QUEUED'),
      resolveListKey(1, 10, 'NEEDS_PICK'),
      resolveListKey(1, 10, 'NO_MATCH'),
      resolveListKey(1, 10, 'EXCLUDED'),
    ]) {
      const response = await request(app).get(key);
      assert.equal(response.status, 200, `${key} ${response.body.message}`);
    }
  });

  it('accepts the detail query, also for instance 0', async () => {
    for (const key of [resolveDetailKey(9001, 0), resolveDetailKey(9001, 3)]) {
      const response = await request(app).get(key);
      assert.equal(response.status, 200, `${key} ${response.body.message}`);
    }
  });

  it('accepts a search for instance 0 and the largest instance ID', async () => {
    for (const instanceId of [0, 2_147_483_647]) {
      const response = await request(app)
        .post('/api/v1/manga/resolve/9001/search')
        .send(searchBody(instanceId));
      assert.equal(response.status, 202, JSON.stringify(response.body));
    }
  });

  it('accepts a select', async () => {
    for (const body of [selectBody(0, 1), selectBody(2, 2_147_483_647)]) {
      const response = await request(app)
        .post('/api/v1/manga/resolve/9001/select')
        .send(body);
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
  });

  it('accepts a bind by Suwayomi manga ID', async () => {
    for (const mangaId of ['1', '2147483647']) {
      const response = await request(app)
        .post('/api/v1/manga/resolve/9001/bind')
        .send(accepted(bindByMangaId(0, mangaId)));
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
  });

  it('accepts a bind by source and URL', async () => {
    for (const [sourceId, url] of [
      ['1002', '/manga/synthetic-1'],
      ['9223372036854775807', 'x'.repeat(2_048)],
    ]) {
      const response = await request(app)
        .post('/api/v1/manga/resolve/9001/bind')
        .send(accepted(bindBySource(0, sourceId, url)));
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
  });

  it('refuses bodies of the wrong shape', async () => {
    for (const [route, body] of [
      ['search', {}],
      ['search', { instanceId: -1 }],
      ['select', { instanceId: 0 }],
      ['select', { instanceId: 0, candidateId: 0 }],
      ['bind', { instanceId: 0 }],
      ['bind', { instanceId: 0, suwayomiMangaId: 1, sourceId: '1002' }],
      ['bind', { instanceId: 0, sourceId: 1002, url: '/manga/1' }],
      ['bind', { instanceId: 0, sourceId: '1002', url: '' }],
    ] as const) {
      const response = await request(app)
        .post(`/api/v1/manga/resolve/9001/${route}`)
        .send(body);
      assert.equal(response.status, 400, `${route} ${JSON.stringify(body)}`);
    }
  });
});

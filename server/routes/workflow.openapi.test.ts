import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';

describe('workflow list filters behind the OpenAPI validator', () => {
  function createValidatedApp(): Express {
    const app = express();
    app.use(express.json());
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    app.get('/api/v1/blocklist', (_req, res) =>
      res.status(200).json({ pageInfo: {}, results: [] })
    );
    app.get('/api/v1/issue', (_req, res) =>
      res.status(200).json({
        pageInfo: {},
        results: [],
        counts: { all: 0, open: 0, resolved: 0 },
      })
    );
    app.get('/api/v1/playback/devices', (_req, res) =>
      res.status(200).json([])
    );
    app.get('/api/v1/playback/watched/:mediaType/:tmdbId', (req, res) =>
      res.status(200).json({
        mediaType: req.params.mediaType,
        tmdbId: Number(req.params.tmdbId),
        serverType: 1,
        availableCount: 1,
        watchedCount: 1,
        unwatchedCount: 0,
      })
    );
    app.get('/api/v1/playback/media/:mediaId', (req, res) =>
      res.status(200).json({
        mediaId: Number(req.params.mediaId),
        serverType: 1,
        is4k: false,
        groups: [],
      })
    );
    app.post('/api/v1/playback/media/:mediaId/play', (_req, res) =>
      res.status(204).send()
    );
    app.post('/api/v1/playback/media/:mediaId/playlist', (_req, res) =>
      res.status(200).json({ url: 'https://media.example/playlist' })
    );
    app.post('/api/v1/playback/collection/play', (_req, res) =>
      res.status(204).send()
    );
    app.post('/api/v1/playback/collection/playlist', (_req, res) =>
      res.status(200).json({ url: 'https://media.example/playlist' })
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

  it('admits Blocklist search and sorting controls', async () => {
    const response = await request(createValidatedApp())
      .get('/api/v1/blocklist')
      .query({
        take: 10,
        skip: 0,
        filter: 'all',
        search: 'director',
        sort: 'mediaType',
        sortDirection: 'asc',
      });

    assert.strictEqual(response.status, 200);
  });

  it('admits Issues search, time, status sorting, and direction controls', async () => {
    const response = await request(createValidatedApp())
      .get('/api/v1/issue')
      .query({
        take: 10,
        skip: 0,
        filter: 'open',
        search: 'playback',
        sort: 'status',
        sortDirection: 'desc',
        timeFrame: '30d',
      });

    assert.strictEqual(response.status, 200);
  });

  it('admits the playback device and catalog routes', async () => {
    const app = createValidatedApp();
    const devices = await request(app).get('/api/v1/playback/devices');
    const catalog = await request(app).get('/api/v1/playback/media/4222');

    assert.strictEqual(devices.status, 200);
    assert.strictEqual(catalog.status, 200);
    assert.strictEqual(catalog.body.mediaId, 4222);
  });

  it('admits the watched-status route and details query', async () => {
    const response = await request(createValidatedApp())
      .get('/api/v1/playback/watched/tv/103516')
      .query({ details: '1' });

    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.strictEqual(response.body.tmdbId, 103516);
  });

  it('admits media and collection playback commands', async () => {
    const app = createValidatedApp();
    const media = await request(app)
      .post('/api/v1/playback/media/4222/play')
      .send({ deviceId: 'browser-device', itemIds: ['episode-1'] });
    const collection = await request(app)
      .post('/api/v1/playback/collection/play')
      .send({ deviceId: 'browser-device', mediaIds: [1, 2] });

    assert.strictEqual(media.status, 204, JSON.stringify(media.body));
    assert.strictEqual(collection.status, 204, JSON.stringify(collection.body));
  });

  it('admits media and collection playlist replacement commands', async () => {
    const app = createValidatedApp();
    const media = await request(app)
      .post('/api/v1/playback/media/4222/playlist')
      .send({ itemIds: ['episode-2', 'episode-1'] });
    const collection = await request(app)
      .post('/api/v1/playback/collection/playlist')
      .send({ mediaIds: [2, 1] });

    assert.strictEqual(media.status, 200, JSON.stringify(media.body));
    assert.strictEqual(collection.status, 200, JSON.stringify(collection.body));
  });
});

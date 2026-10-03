import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MangaRequestScope } from '@server/constants/mangaRequest';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';

import {
  mangaRequestBody,
  mangaRequestEditBody,
  parseMangaScopeDraft,
  type MangaScopeBody,
  type MangaScopeDraft,
} from './mangaRequestScope';

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
  app.post('/api/v1/request', (_req, res) => res.status(201).json({}));
  app.put('/api/v1/request/:requestId', (_req, res) =>
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

const scopeBody = (fields: Partial<MangaScopeDraft>): MangaScopeBody => {
  const { body } = parseMangaScopeDraft({
    scope: MangaRequestScope.ALL_AT_DISPATCH,
    latestCount: '',
    rangeStart: '',
    rangeEnd: '',
    ...fields,
  });
  assert.ok(body, 'the client accepts the draft');
  return body;
};

const scopes: [string, Partial<MangaScopeDraft>][] = [
  ['every chapter', {}],
  [
    'the latest chapter',
    { scope: MangaRequestScope.LATEST_N, latestCount: '1' },
  ],
  [
    'the latest 10,000 chapters',
    { scope: MangaRequestScope.LATEST_N, latestCount: '10000' },
  ],
  [
    'every chapter from 0 onward',
    { scope: MangaRequestScope.RANGE, rangeStart: '0' },
  ],
  [
    'chapters 10.5 to 20',
    { scope: MangaRequestScope.RANGE, rangeStart: '10.5', rangeEnd: '20' },
  ],
  [
    'chapter 1,000,000 alone',
    {
      scope: MangaRequestScope.RANGE,
      rangeStart: '1000000',
      rangeEnd: '1000000',
    },
  ],
];

describe('manga request bodies behind the OpenAPI validator', () => {
  const app = createValidatedApp();

  for (const [name, fields] of scopes) {
    it(`accepts a new request for ${name}`, async () => {
      const response = await request(app)
        .post('/api/v1/request')
        .send(mangaRequestBody(30013, scopeBody(fields)));

      assert.equal(response.status, 201, JSON.stringify(response.body));
    });

    it(`accepts an edit to ${name}`, async () => {
      const response = await request(app)
        .put('/api/v1/request/41')
        .send(mangaRequestEditBody(scopeBody(fields)));

      assert.equal(response.status, 200, JSON.stringify(response.body));
    });
  }

  it('refuses an edit that leaves out the media type', async () => {
    const response = await request(app)
      .put('/api/v1/request/41')
      .send({ mangaScope: scopeBody({}) });

    assert.equal(response.status, 400);
    assert.match(String(response.body.message), /mediaType/);
  });

  it('refuses the first values past the client limits', async () => {
    for (const mangaScope of [
      { scope: MangaRequestScope.LATEST_N, latestCount: 10_001 },
      { scope: MangaRequestScope.RANGE, rangeStart: 1_000_001 },
      { scope: MangaRequestScope.RANGE, rangeStart: 0, rangeEnd: 1_000_001 },
    ]) {
      const response = await request(app)
        .post('/api/v1/request')
        .send({ mediaType: 'manga', mediaId: 30013, mangaScope });

      assert.equal(response.status, 400, JSON.stringify(mangaScope));
    }
  });
});

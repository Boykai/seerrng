import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MangaRequestScope } from '@server/constants/mangaRequest';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';

import {
  buildMangaFollowBody,
  buildMangaFollowCreateField,
  getMangaFollowUrl,
} from './mangaFollow';
import { mangaRequestBody } from './mangaRequestScope';

describe('manga follow client contract', () => {
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
    app.put('/api/v1/request/:requestId/follow', (req, res) =>
      res.status(200).json({ body: req.body })
    );
    app.post('/api/v1/request', (req, res) =>
      res.status(201).json({ body: req.body })
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
          message: error.message,
        })
    );
    return app;
  }

  for (const enabled of [true, false]) {
    it(`sends a body the API accepts when turning following ${
      enabled ? 'on' : 'off'
    }`, async () => {
      const response = await request(createValidatedApp())
        .put(getMangaFollowUrl(31))
        .send(buildMangaFollowBody(enabled));

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { body: { enabled } });
    });
  }

  it('is checked against a validator that rejects a missing choice', async () => {
    const response = await request(createValidatedApp())
      .put(getMangaFollowUrl(31))
      .send({});

    assert.equal(response.status, 400);
  });

  for (const follow of [true, false]) {
    it(`sends a new manga request the API accepts with following ${
      follow ? 'on' : 'off'
    }`, async () => {
      const body = {
        ...mangaRequestBody(31, { scope: MangaRequestScope.ALL_AT_DISPATCH }),
        ...buildMangaFollowCreateField(follow),
      };
      const response = await request(createValidatedApp())
        .post('/api/v1/request')
        .send(body);

      assert.equal(response.status, 201);
      // The validator adds no follow choice that the requester did not make.
      assert.deepEqual(response.body, { body });
    });
  }

  it('is checked against a validator that types the follow choice', async () => {
    const response = await request(createValidatedApp())
      .post('/api/v1/request')
      .send({
        ...mangaRequestBody(31, { scope: MangaRequestScope.ALL_AT_DISPATCH }),
        mangaFollow: 'yes',
      });

    assert.equal(response.status, 400);
  });
});

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';

const createValidatedApp = (): Express => {
  const app = express();
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.get('/api/v1/discover/books', (_req, res) =>
    res.status(200).json({ accepted: true })
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

describe('book discovery responseVersion OpenAPI contract', () => {
  it('accepts the current response contract and retains compatibility with v2', async () => {
    const app = createValidatedApp();

    for (const responseVersion of [2, 3]) {
      const response = await request(app)
        .get('/api/v1/discover/books')
        .query({ responseVersion });

      assert.strictEqual(
        response.status,
        200,
        `responseVersion ${responseVersion} was rejected: ${response.body.message}`
      );
      assert.strictEqual(response.body.accepted, true);
    }
  });

  it('rejects response contract versions that are not documented', async () => {
    const response = await request(createValidatedApp())
      .get('/api/v1/discover/books')
      .query({ responseVersion: 4 });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.message, /responseVersion/);
  });
});

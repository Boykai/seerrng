import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';

describe('magazine discovery behind the OpenAPI validator', () => {
  it('admits the catalog selection sent by the discovery page', async () => {
    const app = express();
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    app.get('/api/v1/discover/magazines', (req, res) =>
      res.status(200).json({ catalog: req.query.catalog })
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

    const response = await request(app)
      .get('/api/v1/discover/magazines')
      .query({ catalog: 'public', query: 'Science' });

    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.strictEqual(response.body.catalog, 'public');
  });
});

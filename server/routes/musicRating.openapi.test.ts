import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

describe('album ratings through the real OpenAPI contract', () => {
  for (const body of [
    {},
    {
      rating: {
        score: 8.5,
        votes: 32,
        url: 'https://musicbrainz.org/',
        source: 'musicbrainz',
      },
    },
    {
      rating: {
        score: 7,
        votes: 8,
        url: 'http://lidarr.local/',
        source: 'lidarr',
      },
    },
  ]) {
    it(`admits and validates ${body.rating?.source ?? 'unavailable'} ratings`, async () => {
      const app = express();
      app.use(
        OpenApiValidator.middleware({
          apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
          validateRequests: true,
          validateResponses: true,
          validateSecurity: false,
        })
      );
      app.get('/api/v1/music/:id/rating', (_req, res) => res.json(body));
      const response = await request(app).get(
        '/api/v1/music/1b022e01-4da6-387b-8658-8678046e4cef/rating'
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body, body);
    });
  }
});

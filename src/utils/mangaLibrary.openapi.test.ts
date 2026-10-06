import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  appendDiscoverQueryString,
  buildDiscoverQueryString,
} from '@server/utils/discoverQuery';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';

import { MANGA_LIBRARY_URL, mangaLibraryPageUrl } from './mangaLibrary';

const createValidatedApp = (): Express => {
  const app = express();
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateResponses: true,
      validateSecurity: false,
    })
  );
  app.get(MANGA_LIBRARY_URL, (req, res) =>
    res.status(200).json({
      page: Number(req.query.page ?? 1),
      totalPages: 1,
      totalResults: 0,
      results: [],
    })
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

describe('manga library URLs through the OpenAPI contract', () => {
  it('admits every page URL the clients send', async () => {
    const app = createValidatedApp();
    const urls = [
      // My Library.
      mangaLibraryPageUrl(1),
      mangaLibraryPageUrl(500),
      // The Manga page shelf (MediaSlider) and the full list (useDiscover).
      `${MANGA_LIBRARY_URL}?${appendDiscoverQueryString({ page: 2, shuffleSeed: undefined })}`,
      `${MANGA_LIBRARY_URL}?${buildDiscoverQueryString({ page: 3 })}`,
    ];

    for (const url of urls) {
      const res = await request(app).get(url);
      assert.equal(res.status, 200, `${url}: ${JSON.stringify(res.body)}`);
    }
  });

  it('refuses pages outside the documented range', async () => {
    const app = createValidatedApp();

    for (const page of [0, 501]) {
      const res = await request(app).get(mangaLibraryPageUrl(page));
      assert.equal(res.status, 400, String(page));
    }
  });
});

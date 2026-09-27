import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import ReadarrAPI from '@server/api/servarr/readarr';
import { getSettings, type ReadarrSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { makeBookshelfSeriesId } from '@server/utils/bookshelfCatalog';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';
import seriesRoutes from './series';

let app: Express;

const createApp = () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 1 } as Express.Request['user'];
    next();
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/series', seriesRoutes);
  app.use(
    (
      err: { status?: number; message?: string; errors?: unknown[] },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({
        status: err.status ?? 500,
        message: err.message,
        errors: err.errors,
      });
    }
  );
  return app;
};

before(() => {
  app = createApp();
});

beforeEach(() => {
  getSettings().readarr = [
    {
      id: 7,
      hostname: 'bookshelf.test',
      port: 8787,
      apiKey: 'test-key',
      useSsl: false,
      baseUrl: '',
      serviceType: 'ebook',
    } as ReadarrSettings,
  ];
});

afterEach(() => {
  mock.restoreAll();
  getSettings().readarr = [];
});

setupTestDb();

describe('GET /series/:id', () => {
  it('accepts a series from the first configured Bookshelf service', async () => {
    getSettings().readarr[0].id = 0;
    const lookupBook = mock.method(
      ReadarrAPI.prototype,
      'lookupBook',
      async () => [
        {
          title: 'The Saga: Book One',
          foreignBookId: 'googlebooks:one',
          seriesTitle: 'The Saga #1',
        },
      ]
    );

    const seriesId = makeBookshelfSeriesId(0, 'The Saga');
    const response = await request(app).get(
      `/api/v1/series/${encodeURIComponent(seriesId)}`
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.books[0].title, 'The Saga: Book One');
    assert.equal(lookupBook.mock.callCount(), 1);
  });

  it('returns Bookshelf books in natural series order and rejects malformed IDs', async () => {
    const lookupBook = mock.method(
      ReadarrAPI.prototype,
      'lookupBook',
      async (query: string) => {
        assert.equal(query, 'The Saga');
        return [
          {
            title: 'The Saga: Book Ten',
            foreignBookId: 'googlebooks:ten',
            seriesTitle: 'Other Series #1; The Saga #10',
          },
          {
            title: 'The Saga: Book Two',
            foreignBookId: 'googlebooks:two',
            seriesTitle: 'Other Series #1; the saga #2',
            audiobookDuration: 3_600,
            narrators: ['Narrator One'],
          },
          {
            title: 'Unrelated Book',
            foreignBookId: 'googlebooks:unrelated',
            seriesTitle: 'Other Series #1',
          },
        ];
      }
    );
    const seriesId = makeBookshelfSeriesId(7, 'The Saga');

    const valid = await request(app).get(
      `/api/v1/series/${encodeURIComponent(seriesId)}`
    );
    const malformed = await request(app).get('/api/v1/series/invalid');

    assert.equal(valid.status, 200, JSON.stringify(valid.body));
    assert.equal(valid.body.title, 'The Saga');
    assert.deepStrictEqual(
      valid.body.books.map((book: { title: string }) => book.title),
      ['The Saga: Book Two', 'The Saga: Book Ten']
    );
    const sagaReference = valid.body.books[0].series.find(
      (series: { title: string }) => series.title === 'The Saga'
    );
    assert.equal(sagaReference.position, '2');
    assert.equal(sagaReference.id, makeBookshelfSeriesId(7, 'The Saga'));
    assert.equal(valid.body.books[0].audiobookDuration, 3_600);
    assert.deepStrictEqual(valid.body.books[0].narrators, ['Narrator One']);
    assert.equal(malformed.status, 404);
    assert.equal(lookupBook.mock.callCount(), 1);
  });
});

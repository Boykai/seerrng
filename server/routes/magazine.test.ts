import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';

import LazyLibrarianAPI from '@server/api/lazylibrarian';
import { getSettings, type LazyLibrarianSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import magazineRoutes from './magazine';

let app: Express;

before(() => {
  app = express();
  app.use('/magazine', magazineRoutes);
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
});

afterEach(() => {
  mock.restoreAll();
  getSettings().lazylibrarian = [];
});

setupTestDb();

const magazineService = (id: number): LazyLibrarianSettings => ({
  id,
  name: `LazyLibrarian ${id}`,
  hostname: `lazylibrarian-${id}.test`,
  port: 5299,
  apiKey: 'test-key',
  useSsl: false,
  isDefault: id === 1,
  tags: [],
  syncEnabled: false,
  preventSearch: false,
});

describe('GET /magazine/:title', () => {
  it('uses a healthy service when the default service fails', async () => {
    getSettings().lazylibrarian = [magazineService(1), magazineService(2)];
    let calls = 0;
    const getIssues = mock.method(
      LazyLibrarianAPI.prototype,
      'getIssues',
      async () => {
        if (++calls === 1) {
          throw new Error('Default service is unavailable');
        }
        return {
          magazine: { title: 'Science Monthly' },
          issues: [{ title: 'October 2026', issueFile: '/books/issue.pdf' }],
        };
      }
    );

    const res = await request(app).get('/magazine/Science%20Monthly');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(getIssues.mock.callCount(), 2);
    assert.strictEqual(res.body.issues[0]?.available, true);
  });

  it('finds a title on another service when the default has no issues', async () => {
    getSettings().lazylibrarian = [magazineService(1), magazineService(2)];
    let calls = 0;
    mock.method(LazyLibrarianAPI.prototype, 'getIssues', async () => {
      if (++calls === 1) {
        return { issues: [] };
      }
      return {
        magazine: {
          title: 'Science Monthly',
          latestCover: `cache/magazine/${'a'.repeat(40)}.jpg`,
        },
        issues: [{ title: 'October 2026' }],
      };
    });

    const res = await request(app).get('/magazine/Science%20Monthly');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.issues.length, 1);
    assert.strictEqual(
      res.body.posterPath,
      `/api/v1/magazine/cover/2/${'a'.repeat(40)}`
    );
  });

  it('reports unavailable details when every service fails', async () => {
    getSettings().lazylibrarian = [magazineService(1), magazineService(2)];
    mock.method(LazyLibrarianAPI.prototype, 'getIssues', async () => {
      throw new Error('Service is unavailable');
    });

    const res = await request(app).get('/magazine/Science%20Monthly');

    assert.strictEqual(res.status, 503);
  });
});

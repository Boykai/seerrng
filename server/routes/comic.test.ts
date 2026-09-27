import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';

import ComicVineAPI from '@server/api/comicvine';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import comicRoutes from './comic';

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      cookie: { secure: 'auto' },
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(rateLimit({ windowMs: 60_000, limit: 10_000 }), checkUser);
  app.use('/auth', authRoutes);
  app.use('/comic', comicRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(() => {
  app = createApp();
});

afterEach(() => {
  mock.restoreAll();
});

setupTestDb();

async function login(email = 'admin@seerr.dev') {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

function mockComicVolume() {
  mock.method(ComicVineAPI.prototype, 'getVolume', async () => ({
    id: 4567,
    name: 'Test Comic',
    resource_type: 'volume',
    publisher: { id: 1, name: 'Test Publisher' },
    count_of_issues: 12,
  }));
}

describe('GET /comic/:id', () => {
  it('reports 503 when ComicVine is not configured', async () => {
    getSettings().main.comicVineApiKey = '';
    const agent = await login();

    const res = await agent.get('/comic/4567');

    assert.strictEqual(res.status, 503);
  });

  it('returns comic details for a valid ComicVine id', async () => {
    getSettings().main.comicVineApiKey = 'test-comicvine-key';
    mockComicVolume();

    const agent = await login();
    const res = await agent.get('/comic/4567');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, '4567');
    assert.strictEqual(res.body.title, 'Test Comic');
    assert.strictEqual(res.body.onUserWatchlist, false);
  });

  it('reports whether the current user has the comic on their watchlist', async () => {
    getSettings().main.comicVineApiKey = 'test-comicvine-key';
    mockComicVolume();

    const agent = await login();
    const user = await getRepository(User).findOneByOrFail({
      email: 'admin@seerr.dev',
    });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 0,
        mediaType: MediaType.COMIC,
      })
    );
    await getRepository(MediaIdentifier).save(
      new MediaIdentifier({
        media,
        provider: MediaIdentifierProvider.COMICVINE,
        value: '4567',
        canonical: true,
      })
    );
    await getRepository(Watchlist).save(
      new Watchlist({
        externalId: '4567',
        mediaType: MediaType.COMIC,
        title: 'Test Comic',
        requestedBy: user,
        media,
      })
    );

    const res = await agent.get('/comic/4567');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.onUserWatchlist, true);
  });

  it('returns 404 for a malformed comic id', async () => {
    getSettings().main.comicVineApiKey = 'test-comicvine-key';
    const getVolume = mock.method(ComicVineAPI.prototype, 'getVolume');

    const agent = await login();
    const res = await agent.get('/comic/not-a-number');

    assert.strictEqual(res.status, 404);
    assert.strictEqual(getVolume.mock.callCount(), 0);
  });

  it('redacts ComicVine API keys from detail lookup failure logs', async () => {
    getSettings().main.comicVineApiKey = 'test-comicvine-key';
    mock.method(ComicVineAPI.prototype, 'getVolume', async () => {
      throw new Error('Upstream rejected api_key=test-comicvine-key');
    });
    const errorLog = mock.method(logger, 'error', () => undefined);

    const agent = await login();
    const res = await agent.get('/comic/4567');

    assert.strictEqual(res.status, 500);
    const loggedArguments = errorLog.mock.calls[0]
      .arguments as unknown as unknown[];
    assert.doesNotMatch(JSON.stringify(loggedArguments), /test-comicvine-key/);
  });
});

describe('GET /comic/:id/issues', () => {
  it('returns a paged list of back issues with cover metadata', async () => {
    getSettings().main.comicVineApiKey = 'test-comicvine-key';
    const getIssues = mock.method(
      ComicVineAPI.prototype,
      'getVolumeIssues',
      async () => ({
        offset: 20,
        number_of_total_results: 41,
        results: [
          {
            id: 22,
            name: 'A back issue',
            issue_number: '22',
            cover_date: '2025-09-01',
          },
        ],
      })
    );

    const agent = await login();
    const res = await agent.get('/comic/4567/issues?page=2');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(getIssues.mock.calls[0].arguments[0], {
      volumeId: 4567,
      page: 2,
      limit: 20,
    });
    assert.strictEqual(res.body.totalPages, 3);
    assert.strictEqual(res.body.results[0].issueNumber, '22');
    assert.strictEqual(res.body.results[0].coverDate, '2025-09-01');
  });

  it('does not call ComicVine for a malformed volume ID', async () => {
    getSettings().main.comicVineApiKey = 'test-comicvine-key';
    const getIssues = mock.method(ComicVineAPI.prototype, 'getVolumeIssues');

    const agent = await login();
    const res = await agent.get('/comic/not-a-number/issues');

    assert.strictEqual(res.status, 404);
    assert.strictEqual(getIssues.mock.callCount(), 0);
  });

  it('redacts ComicVine API keys from issue lookup failure logs', async () => {
    getSettings().main.comicVineApiKey = 'test-comicvine-key';
    mock.method(ComicVineAPI.prototype, 'getVolumeIssues', async () => {
      throw new Error('Upstream rejected api_key=test-comicvine-key');
    });
    const errorLog = mock.method(logger, 'error', () => undefined);

    const agent = await login();
    const res = await agent.get('/comic/4567/issues');

    assert.strictEqual(res.status, 503);
    const loggedArguments = errorLog.mock.calls[0]
      .arguments as unknown as unknown[];
    assert.doesNotMatch(JSON.stringify(loggedArguments), /test-comicvine-key/);
  });
});

import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import {
  MangaRequestBindingState,
  MangaRequestScope,
} from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import notificationManager from '@server/lib/notifications';
import requestDispatchManager from '@server/lib/requestDispatch';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import { seedDispatchRequest } from '@server/test/fakeSuwayomiDispatch';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import type { Express } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import request from 'supertest';
import userRoutes from '.';

let app: Express;

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: true },
      proxy: true,
    })
  );
  app.use(rateLimit({ windowMs: 60_000, limit: 10_000 }), checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
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
};

before(() => {
  app = createApp();
});

setupTestDb();

beforeEach(() => {
  mock.method(requestDispatchManager, 'enqueue', async () => undefined);
  mock.method(notificationManager, 'sendNotificationIntent', async () => {
    return;
  });
});

afterEach(async () => {
  try {
    await waitForBackgroundTasks();
  } finally {
    mock.restoreAll();
  }
});

const loginAsAdmin = async (): Promise<string> => {
  getSettings().main.localLogin = true;
  const res = await request(app)
    .post('/auth/local')
    .set('X-Forwarded-Proto', 'https')
    .send({ email: 'admin@seerr.dev', password: 'test1234' });
  assert.strictEqual(res.status, 200);
  return res.headers['set-cookie'][0].split(';', 1)[0];
};

/** A pending movie request by the seeded user 2. */
const seedMovieRequest = async (tmdbId: number): Promise<number> => {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const { id } = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      isAutoRequest: false,
    })
  );
  return id;
};

interface ResultRow {
  id: number;
  type: string;
  media: { identifiers?: { provider: string; value: string }[] };
  mangaScope?: Record<string, unknown>;
}

describe('GET /user/:id/requests', () => {
  it('carries the AniList ID and chapter scope of each manga request on the page', async () => {
    const latest = await seedDispatchRequest({
      anilistId: 9001,
      manifest: { scope: MangaRequestScope.LATEST_N, latestCount: 25 },
    });
    const movie = await seedMovieRequest(550);
    const waiting = await seedDispatchRequest({
      anilistId: 9002,
      status: MediaRequestStatus.PENDING,
      manifest: {
        scope: MangaRequestScope.RANGE,
        rangeStart: 10,
        rangeEnd: 20,
        bindingState: MangaRequestBindingState.AWAITING_BINDING,
        boundAt: null,
      },
    });
    const cookie = await loginAsAdmin();
    const page = (skip: number) =>
      request(app)
        .get('/user/2/requests')
        .query({ take: 2, skip })
        .set('Cookie', cookie)
        .set('X-Forwarded-Proto', 'https');

    const first = await page(0);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.deepStrictEqual(first.body.pageInfo, {
      pages: 2,
      pageSize: 2,
      results: 3,
      page: 1,
    });
    const [newest, middle] = first.body.results as ResultRow[];
    assert.deepStrictEqual([newest.id, middle.id], [waiting.request.id, movie]);
    assert.deepStrictEqual(
      newest.media.identifiers?.map(({ provider, value }) => ({
        provider,
        value,
      })),
      [{ provider: 'anilist', value: '9002' }]
    );
    assert.deepStrictEqual(
      {
        scope: newest.mangaScope?.scope,
        rangeStart: newest.mangaScope?.rangeStart,
        rangeEnd: newest.mangaScope?.rangeEnd,
        awaitingBinding: newest.mangaScope?.awaitingBinding,
      },
      {
        scope: MangaRequestScope.RANGE,
        rangeStart: 10,
        rangeEnd: 20,
        awaitingBinding: true,
      }
    );
    // Other media types keep the payload they had.
    assert.strictEqual(middle.type, 'movie');
    assert.strictEqual(middle.media.identifiers, undefined);
    assert.strictEqual(middle.mangaScope, undefined);

    const second = await page(2);
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body.pageInfo.page, 2);
    const [oldest] = second.body.results as ResultRow[];
    assert.strictEqual(second.body.results.length, 1);
    assert.strictEqual(oldest.id, latest.request.id);
    assert.deepStrictEqual(
      oldest.media.identifiers?.map(({ value }) => value),
      ['9001']
    );
    assert.deepStrictEqual(
      {
        scope: oldest.mangaScope?.scope,
        latestCount: oldest.mangaScope?.latestCount,
        awaitingBinding: oldest.mangaScope?.awaitingBinding,
      },
      {
        scope: MangaRequestScope.LATEST_N,
        latestCount: 25,
        awaitingBinding: false,
      }
    );
  });
});

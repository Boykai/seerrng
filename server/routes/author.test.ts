import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import OpenLibraryAPI from '@server/api/openlibrary';
import ReadarrAPI from '@server/api/servarr/readarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import { makeBookshelfAuthorId } from '@server/utils/bookshelfCatalog';
import { MAX_PAGINATION_OFFSET } from '@server/utils/pagination';
import type { Express } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import authorRoutes from './author';

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
  app.use('/author', authorRoutes);
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

beforeEach(() => {
  mock.method(MediaRequest, 'sendNotification', async () => undefined);
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

describe('GET /author/:id', () => {
  it('rejects malformed author IDs before calling OpenLibrary', async () => {
    const getAuthor = mock.method(OpenLibraryAPI.prototype, 'getAuthor');
    const getAuthorWorks = mock.method(
      OpenLibraryAPI.prototype,
      'getAuthorWorks'
    );

    const agent = await login();
    const responses = await Promise.all([
      agent.get(`/author/${'x'.repeat(129)}`),
      agent.get(`/author/${encodeURIComponent('../../search')}`),
    ]);

    assert.deepStrictEqual(
      responses.map((response) => response.status),
      [404, 404]
    );
    assert.strictEqual(getAuthor.mock.callCount(), 0);
    assert.strictEqual(getAuthorWorks.mock.callCount(), 0);
  });

  it('returns author works with pagination and existing media state', async () => {
    mock.method(OpenLibraryAPI.prototype, 'getAuthor', async () => ({
      key: '/authors/OL1A',
      name: 'Test Author',
      bio: { value: 'Writes test books.' },
      birth_date: '1970',
      photos: [123],
    }));
    mock.method(
      OpenLibraryAPI.prototype,
      'getAuthorWorks',
      async (
        _authorId: string,
        { limit, offset }: { limit: number; offset: number }
      ) => ({
        size: 2,
        entries: [
          {
            key: '/works/OL1W',
            title: 'Existing Work',
            covers: [11],
            first_publish_date: '2001',
          },
          {
            key: '/works/OL2W',
            title: 'New Work',
            first_publish_date: '2002',
          },
        ].slice(offset, offset + limit),
      })
    );

    const requestedBy = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.BOOK,
        tmdbId: 0,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
        serviceUrl: 'http://readarr.internal/book/1',
        externalServiceSlug: 'existing-work',
        ratingKey: 'plex-existing-work',
      })
    );
    await getRepository(MediaIdentifier).save(
      new MediaIdentifier({
        media,
        provider: MediaIdentifierProvider.OPENLIBRARY,
        value: 'OL1W',
        canonical: true,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.BOOK,
        media,
        requestedBy,
        status: MediaRequestStatus.PENDING,
        is4k: false,
        bookFormat: 'ebook',
      })
    );

    const agent = await login('friend@seerr.dev');
    const res = await agent.get('/author/OL1A?limit=1&offset=0');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, 'OL1A');
    assert.strictEqual(res.body.name, 'Test Author');
    assert.strictEqual(res.body.biography, 'Writes test books.');
    assert.deepStrictEqual(res.body.pagination, {
      limit: 1,
      offset: 0,
      totalItems: 2,
      nextOffset: 1,
    });
    assert.strictEqual(res.body.works.length, 1);
    assert.strictEqual(res.body.works[0].id, 'OL1W');
    assert.strictEqual(res.body.works[0].author, 'Test Author');
    assert.strictEqual(res.body.works[0].mediaInfo.status, MediaStatus.PENDING);
    assert.strictEqual(res.body.works[0].mediaInfo.requests.length, 1);
    assert.strictEqual(res.body.works[0].mediaInfo.serviceUrl, undefined);
    assert.strictEqual(
      res.body.works[0].mediaInfo.externalServiceSlug,
      undefined
    );
    assert.strictEqual(res.body.works[0].mediaInfo.ratingKey, undefined);
  });

  it('uses a configured Bookshelf author image when Open Library has no photo', async () => {
    const settings = getSettings();
    const previousReadarr = settings.readarr;
    settings.readarr = [
      {
        id: 14,
        name: 'Softcover Bookshelf',
        hostname: 'bookshelf.local',
        port: 8787,
        apiKey: 'test-key',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'Default',
        activeDirectory: '/books',
        tags: [],
        is4k: false,
        isDefault: true,
        syncEnabled: false,
        preventSearch: true,
        tagRequests: false,
        overrideRule: [],
        serviceType: 'ebook',
      },
    ];
    mock.method(OpenLibraryAPI.prototype, 'getAuthor', async () => ({
      key: '/authors/OL1A',
      name: 'Test Author',
      photos: [],
    }));
    mock.method(OpenLibraryAPI.prototype, 'getAuthorWorks', async () => ({
      size: 0,
      entries: [],
    }));
    mock.method(ReadarrAPI.prototype, 'lookupAuthor', async () => [
      {
        id: 42,
        foreignAuthorId: 'goodreads-author-42',
        authorName: 'Test Author',
        remotePoster: 'https://covers.example/author.jpg',
      },
    ]);
    mock.method(ReadarrAPI.prototype, 'getAuthorCover', async () => ({
      imageBuffer: Buffer.from('fake-image'),
      contentType: 'image/jpeg',
    }));

    try {
      const agent = await login();
      const res = await agent.get('/author/OL1A');

      assert.strictEqual(res.status, 200);
      assert.match(res.body.posterPath, /\/api\/v1\/author\/OL1A\/cover/);
      assert.match(res.body.posterPath, /serviceId=14/);
      assert.match(res.body.posterPath, /bookshelfAuthorId=42/);

      const image = await agent.get(res.body.posterPath.replace('/api/v1', ''));
      assert.strictEqual(image.status, 200);
      assert.strictEqual(image.headers['content-type'], 'image/jpeg');
      assert.strictEqual(image.body.toString(), 'fake-image');
    } finally {
      settings.readarr = previousReadarr;
    }
  });
});

describe('GET /author/:id/works', () => {
  it('paginates Bookshelf bibliography works through the same route', async () => {
    const settings = getSettings();
    const previousReadarr = settings.readarr;
    settings.readarr = [
      {
        id: 0,
        hostname: 'bookshelf.test',
        port: 8787,
        apiKey: 'test-key',
        useSsl: false,
        baseUrl: '',
        serviceType: 'ebook',
      },
    ];
    mock.method(ReadarrAPI.prototype, 'lookupAuthor', async () => [
      { foreignAuthorId: 'tolkien', authorName: 'J.R.R. Tolkien' },
    ]);
    mock.method(ReadarrAPI.prototype, 'lookupBook', async () =>
      Array.from({ length: 15 }, (_, index) => ({
        foreignBookId: String(index + 1),
        title: `Book ${index + 1}`,
        author: {
          foreignAuthorId: 'tolkien',
          authorName: 'J.R.R. Tolkien',
        },
      }))
    );

    try {
      const agent = await login();
      const id = makeBookshelfAuthorId(0, 'tolkien', 'J.R.R. Tolkien');
      const first = await agent.get(
        `/author/${encodeURIComponent(id)}/works?limit=10&offset=0`
      );
      const second = await agent.get(
        `/author/${encodeURIComponent(id)}/works?limit=10&offset=10`
      );

      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.works.length, 10);
      assert.deepStrictEqual(first.body.pagination, {
        limit: 10,
        offset: 0,
        totalItems: 15,
        nextOffset: 10,
      });
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body.works.length, 5);
      assert.deepStrictEqual(second.body.pagination, {
        limit: 10,
        offset: 10,
        totalItems: 15,
        nextOffset: 15,
      });
    } finally {
      settings.readarr = previousReadarr;
    }
  });

  it('rejects malformed author work IDs before calling OpenLibrary', async () => {
    const getAuthor = mock.method(OpenLibraryAPI.prototype, 'getAuthor');
    const getAuthorWorks = mock.method(
      OpenLibraryAPI.prototype,
      'getAuthorWorks'
    );

    const agent = await login();
    const res = await agent.get(`/author/${'x'.repeat(129)}/works`);

    assert.strictEqual(res.status, 404);
    assert.strictEqual(getAuthor.mock.callCount(), 0);
    assert.strictEqual(getAuthorWorks.mock.callCount(), 0);
  });

  it('loads a later page of bibliography works', async () => {
    mock.method(OpenLibraryAPI.prototype, 'getAuthor', async () => ({
      key: '/authors/OL1A',
      name: 'Test Author',
    }));
    mock.method(
      OpenLibraryAPI.prototype,
      'getAuthorWorks',
      async (
        _authorId: string,
        { limit, offset }: { limit: number; offset: number }
      ) => ({
        size: 2,
        entries: [
          {
            key: '/works/OL1W',
            title: 'Existing Work',
          },
          {
            key: '/works/OL2W',
            title: 'Later Work',
          },
        ].slice(offset, offset + limit),
      })
    );

    const agent = await login();
    const res = await agent.get('/author/OL1A/works?limit=1&offset=1');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.pagination, {
      limit: 1,
      offset: 1,
      totalItems: 2,
      nextOffset: 2,
    });
    assert.strictEqual(res.body.works.length, 1);
    assert.strictEqual(res.body.works[0].id, 'OL2W');
    assert.strictEqual(res.body.works[0].author, 'Test Author');
  });

  it('returns an empty bibliography when Open Library works stalls', async () => {
    mock.method(OpenLibraryAPI.prototype, 'getAuthor', async () => ({
      key: '/authors/OL1A',
      name: 'Test Author',
    }));
    mock.method(
      OpenLibraryAPI.prototype,
      'getAuthorWorks',
      async () => new Promise(() => {})
    );

    const agent = await login();
    const res = await agent.get('/author/OL1A/works');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.works, []);
    assert.deepStrictEqual(res.body.pagination, {
      limit: 20,
      offset: 0,
      totalItems: 0,
      nextOffset: 0,
    });
  });

  it('caps provider offsets before fetching author works', async () => {
    mock.method(OpenLibraryAPI.prototype, 'getAuthor', async () => ({
      key: '/authors/OL1A',
      name: 'Test Author',
    }));
    let providerOffset: number | undefined;
    mock.method(
      OpenLibraryAPI.prototype,
      'getAuthorWorks',
      async (
        _authorId: string,
        { offset }: { limit: number; offset: number }
      ) => {
        providerOffset = offset;
        return { size: 0, entries: [] };
      }
    );

    const agent = await login();
    const res = await agent.get(
      `/author/OL1A/works?offset=${Number.MAX_SAFE_INTEGER}`
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(providerOffset, MAX_PAGINATION_OFFSET);
    assert.strictEqual(res.body.pagination.offset, MAX_PAGINATION_OFFSET);
  });
});

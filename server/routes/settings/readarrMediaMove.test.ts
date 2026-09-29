import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import ReadarrAPI from '@server/api/servarr/readarr';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { Permission } from '@server/lib/permissions';
import type { ReadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';

import settingsRoutes from '@server/routes/settings';

setupTestDb();

const service: ReadarrSettings = {
  id: 11,
  name: 'Combined Bookshelf',
  hostname: 'bookshelf.local',
  port: 8787,
  apiKey: 'bookshelf-secret',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'Standard',
  activeDirectory: '/media/books',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
  serviceType: 'ebook',
};

const authors = [
  {
    id: 4,
    name: 'Octavia Butler',
    path: '/media/books',
    ebookPath: '/media/ebooks',
    audiobookPath: '/media/audiobooks',
    bookFileCount: 3,
  },
];

const preview = {
  format: 'ebook' as const,
  destinationRootPath: '/media/new-books',
  previewToken: 'fresh-preview-token',
  authorCount: 1,
  mediaFileCount: 1,
  sidecarFileCount: 0,
  missingFileCount: 0,
  totalSize: 100,
  requiredCopyBytes: 100,
  availableSpace: 10_000,
  canMove: true,
  warnings: [],
  conflicts: [],
  authors: [],
};

const roots = [
  {
    id: 1,
    path: '/media/new-books',
    freeSpace: 10_000,
    totalSpace: 20_000,
    accessible: true,
    unmappedFolders: [],
  },
  {
    id: 2,
    path: '/media/locked',
    freeSpace: 0,
    totalSpace: 20_000,
    accessible: false,
    unmappedFolders: [],
  },
];

const createApp = (permissions = Permission.ADMIN) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    void _res;
    req.user = new User({ id: 1, permissions });
    next();
  });
  app.use('/settings', settingsRoutes);
  app.use(
    (
      error: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      void _next;
      return res
        .status(error.status ?? 500)
        .json({ status: error.status ?? 500, message: error.message });
    }
  );
  return app;
};

const createOpenApiValidatedApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    void _res;
    req.user = new User({ id: 1, permissions: Permission.ADMIN });
    next();
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/settings', settingsRoutes);
  app.use(
    (
      error: { status?: number; message?: string; errors?: unknown[] },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      void _next;
      return res.status(error.status ?? 500).json({
        status: error.status ?? 500,
        message: error.message,
        errors: error.errors,
      });
    }
  );
  return app;
};

before(() => {
  initI18n();
});

beforeEach(() => {
  getSettings().readarr = [service];
  mock.method(ReadarrAPI.prototype, 'getMediaMoveAuthors', async () => authors);
  mock.method(ReadarrAPI.prototype, 'getRootFolders', async () => roots);
});

afterEach(() => {
  getSettings().readarr = [];
  mock.restoreAll();
});

describe('Bookshelf media-move settings API', () => {
  it('returns only bounded, format-specific author details and accessible roots', async () => {
    const response = await request(createApp())
      .get('/settings/readarr/11/media-move/configuration?format=audiobook')
      .expect(200);

    assert.equal(response.body.serviceId, 11);
    assert.equal(response.body.format, 'audiobook');
    assert.deepEqual(response.body.authors, [
      {
        id: 4,
        name: 'Octavia Butler',
        path: '/media/books',
        currentFormatPath: '/media/audiobooks',
        bookFileCount: 3,
      },
    ]);
    assert.deepEqual(response.body.rootFolders, [
      { id: 1, path: '/media/new-books', accessible: true },
      { id: 2, path: '/media/locked', accessible: false },
    ]);
    assert.equal(
      JSON.stringify(response.body).includes('bookshelf-secret'),
      false
    );
  });

  it('rejects inaccessible destinations and authors outside the requested source', async () => {
    const app = createApp();
    const inaccessible = await request(app)
      .post('/settings/readarr/11/media-move/preview')
      .send({
        authorIds: [4],
        format: 'ebook',
        sourceRootPath: '/media/ebooks',
        destinationRootPath: '/media/locked',
      })
      .expect(400);
    assert.match(inaccessible.body.message, /accessible destination root/);

    const wrongSource = await request(app)
      .post('/settings/readarr/11/media-move/preview')
      .send({
        authorIds: [4],
        format: 'ebook',
        sourceRootPath: '/media/wrong',
        destinationRootPath: '/media/new-books',
      })
      .expect(400);
    assert.match(
      wrongSource.body.message,
      /no longer match this source folder/
    );
  });

  it('previews, starts with the fresh token, and polls the queued command', async () => {
    const previewCall = mock.method(
      ReadarrAPI.prototype,
      'previewMediaMoveBatch',
      async () => preview
    );
    const startCall = mock.method(
      ReadarrAPI.prototype,
      'startMediaMoveBatch',
      async () => ({ id: 91, name: 'MoveAuthorMediaBatch', status: 'queued' })
    );
    const commandCall = mock.method(
      ReadarrAPI.prototype,
      'getMediaMoveCommand',
      async () => ({
        id: 91,
        name: 'MoveAuthorMediaBatch',
        status: 'completed',
        progress: 100,
      })
    );
    const app = createApp();
    const body = {
      authorIds: [4],
      format: 'ebook',
      sourceRootPath: '/media/ebooks',
      destinationRootPath: '/media/new-books',
    };

    const previewResponse = await request(app)
      .post('/settings/readarr/11/media-move/preview')
      .send(body)
      .expect(200);
    assert.equal(previewResponse.body.previewToken, 'fresh-preview-token');
    assert.deepEqual(previewCall.mock.calls[0]?.arguments[0], {
      authorIds: [4],
      format: 'ebook',
      destinationRootPath: '/media/new-books',
    });

    const startResponse = await request(app)
      .post('/settings/readarr/11/media-move/start')
      .send({ ...body, previewToken: previewResponse.body.previewToken })
      .expect(202);
    assert.equal(startResponse.body.command.id, 91);
    assert.equal(
      startCall.mock.calls[0]?.arguments[0]?.previewToken,
      'fresh-preview-token'
    );

    const statusResponse = await request(app)
      .get('/settings/readarr/11/media-move/commands/91')
      .expect(200);
    assert.equal(statusResponse.body.command.status, 'completed');
    assert.equal(commandCall.mock.calls.length, 1);
  });

  it('requires administrator permission for every media-move route', async () => {
    await getRepository(User).update(1, { permissions: Permission.REQUEST });
    const app = createApp(Permission.REQUEST);
    await Promise.all([
      request(app)
        .get('/settings/readarr/11/media-move/configuration?format=ebook')
        .expect(403),
      request(app)
        .post('/settings/readarr/11/media-move/preview')
        .send({
          authorIds: [4],
          format: 'ebook',
          destinationRootPath: '/media/new-books',
        })
        .expect(403),
      request(app)
        .post('/settings/readarr/11/media-move/start')
        .send({
          authorIds: [4],
          format: 'ebook',
          destinationRootPath: '/media/new-books',
          previewToken: 'fresh-preview-token',
        })
        .expect(403),
      request(app)
        .get('/settings/readarr/11/media-move/commands/91')
        .expect(403),
    ]);
  });

  it('keeps the configuration and preview responses aligned with the OpenAPI contract', async () => {
    mock.method(
      ReadarrAPI.prototype,
      'previewMediaMoveBatch',
      async () => preview
    );
    mock.method(ReadarrAPI.prototype, 'startMediaMoveBatch', async () => ({
      id: 91,
      name: 'MoveAuthorMediaBatch',
      status: 'queued' as const,
    }));
    mock.method(ReadarrAPI.prototype, 'getMediaMoveCommand', async () => ({
      id: 91,
      name: 'MoveAuthorMediaBatch',
      status: 'completed' as const,
      progress: 100,
    }));
    const app = createOpenApiValidatedApp();
    await request(app)
      .get('/api/v1/settings/readarr/11/media-move/configuration?format=ebook')
      .expect(200);
    await request(app)
      .post('/api/v1/settings/readarr/11/media-move/preview')
      .send({
        authorIds: [4],
        format: 'ebook',
        destinationRootPath: '/media/new-books',
      })
      .expect(200);
    await request(app)
      .post('/api/v1/settings/readarr/11/media-move/start')
      .send({
        authorIds: [4],
        format: 'ebook',
        destinationRootPath: '/media/new-books',
        previewToken: 'fresh-preview-token',
      })
      .expect(202);
    await request(app)
      .get('/api/v1/settings/readarr/11/media-move/commands/91')
      .expect(200);
  });

  it('returns an actionable update message when Bookshelf lacks move support', async () => {
    mock.restoreAll();
    mock.method(ReadarrAPI.prototype, 'getMediaMoveAuthors', async () => {
      throw { response: { status: 404 } };
    });
    mock.method(ReadarrAPI.prototype, 'getRootFolders', async () => roots);

    const response = await request(createApp())
      .get('/settings/readarr/11/media-move/configuration?format=ebook')
      .expect(409);
    assert.match(response.body.message, /Update BookshelfNG/);
  });
});

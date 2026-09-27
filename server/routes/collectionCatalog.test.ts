import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import * as catalogs from '@server/lib/collectionCatalog';
import * as sync from '@server/lib/collectionSync';
import * as runtimeConfig from '@server/lib/externalRuntimeConfig';
import { Permission } from '@server/lib/permissions';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import router from './collectionCatalog';

const app = (admin: boolean) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = new User({
      id: 1,
      permissions: admin ? Permission.ADMIN : Permission.REQUEST_TV,
    });
    next();
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/collection-catalog', router);
  app.use(
    (
      error: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // Express requires the fourth argument to register an error handler.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(error.status ?? 500).json({ message: error.message })
  );
  return app;
};
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(catalogs, 'getCuratedCollection').mockResolvedValue({
    id: '55',
    kind: 'tv',
    name: 'Collection',
    overview: '',
    sourceUrl: '',
    parts: [],
  });
  vi.spyOn(Media, 'getRelatedMedia').mockResolvedValue([]);
  vi.spyOn(sync, 'checkCollection').mockResolvedValue({
    supported: true,
    checkedAt: 1,
    destinations: [
      {
        libraryId: '1',
        libraryName: 'Series',
        count: 1,
        state: 'missing',
        managed: false,
      },
    ],
  });
});
describe('TV/music collection routes', () => {
  it('returns library qualities for albums with no media-server playback links', async () => {
    const id = 'cb93e87f-5d21-3447-a6e8-22d44f9b0d7a';
    vi.spyOn(runtimeConfig, 'getExternalRuntimeConfig').mockReturnValue({
      lidarr: [
        { id: 0, name: 'Lidarr MP3', activeProfileName: 'MP3' },
        { id: 1, name: 'Lidarr FLAC', activeProfileName: 'FLAC' },
      ],
    } as ReturnType<typeof runtimeConfig.getExternalRuntimeConfig>);
    vi.mocked(catalogs.getCuratedCollection).mockResolvedValue({
      id,
      kind: 'music',
      name: 'Madonna Collection',
      overview: '',
      sourceUrl: '',
      parts: [{ id, title: 'Ray of Light', releaseDate: '1998', genres: [] }],
    });
    vi.mocked(Media.getRelatedMedia).mockResolvedValue([
      {
        id: 4711,
        mbId: id,
        status: 5,
        availableMusicServiceIds: [0, 1],
      } as Media,
    ]);
    const result = await request(app(false))
      .get(`/api/v1/collection-catalog/music/${id}`)
      .expect(200);
    expect(result.body.parts[0].availableQualities).toEqual(['MP3', 'FLAC']);
    expect(result.body.parts[0].mediaInfo.ratingKeyMp3).toBeUndefined();
  });
  it.each(['tv/55', 'music/11111111-1111-4111-8111-111111111111'])(
    'admits reads and validated actions through OpenAPI: %s',
    async (source) => {
      const base = `/api/v1/collection-catalog/${source}`;
      expect((await request(app(true)).get(base)).status).toBe(200);
      expect(
        (await request(app(true)).post(`${base}/availability`)).status
      ).toBe(200);
      expect(
        (
          await request(app(true))
            .post(`${base}/server`)
            .send({ libraryIds: ['1'], selectedIds: ['11'] })
        ).status
      ).toBe(200);
      expect(
        (
          await request(app(true))
            .delete(`${base}/server`)
            .send({
              destinations: [{ libraryId: '1', removalToken: 'a'.repeat(64) }],
            })
        ).status
      ).toBe(200);
    }
  );
  it('requires admin for writes and hides destination/removal details from ordinary readers', async () => {
    const base = '/api/v1/collection-catalog/tv/55';
    expect(
      (
        await request(app(false))
          .post(`${base}/server`)
          .send({ libraryIds: ['1'], selectedIds: ['11'] })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app(false))
          .delete(`${base}/server`)
          .send({
            destinations: [{ libraryId: '1', removalToken: 'a'.repeat(64) }],
          })
      ).status
    ).toBe(403);
    expect(
      (await request(app(false)).post(`${base}/availability`)).body.sync
        .destinations
    ).toEqual([]);
    expect(
      (
        await request(app(true))
          .post(`${base}/server`)
          .send({ libraryIds: ['1'], selectedIds: [] })
      ).status
    ).toBe(400);
  });
});

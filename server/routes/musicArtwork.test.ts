import CoverArtArchive from '@server/api/coverartarchive';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import path from 'node:path';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import musicRoutes from './music';

const id = 'cb93e87f-5d21-3447-a6e8-22d44f9b0d7a';
const app = express();
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
    validateRequests: true,
    validateSecurity: false,
  })
);
app.use('/api/v1/music', musicRoutes);
afterEach(() => vi.restoreAllMocks());
it('returns cover artwork without loading album or service details', async () => {
  vi.spyOn(CoverArtArchive.prototype, 'getCoverArt').mockResolvedValue({
    images: [
      { front: true, thumbnails: { 250: 'https://archive.org/cover.jpg' } },
    ],
    release: '',
  } as Awaited<ReturnType<CoverArtArchive['getCoverArt']>>);
  const result = await request(app)
    .get(`/api/v1/music/${id}/artwork`)
    .expect(200);
  expect(result.body).toEqual({ posterPath: 'https://archive.org/cover.jpg' });
});
it('returns a stable empty result only for a confirmed missing cover', async () => {
  vi.spyOn(CoverArtArchive.prototype, 'getCoverArt').mockResolvedValue({
    images: [],
    release: '',
  });
  vi.spyOn(CoverArtArchive.prototype, 'getCoverArtFromCache').mockResolvedValue(
    null
  );
  expect(
    (await request(app).get(`/api/v1/music/${id}/artwork`).expect(200)).body
  ).toEqual({ posterPath: null });
});
it('lets callers retry transient provider failures', async () => {
  vi.spyOn(CoverArtArchive.prototype, 'getCoverArt').mockResolvedValue({
    images: [],
    release: '',
  });
  vi.spyOn(CoverArtArchive.prototype, 'getCoverArtFromCache').mockResolvedValue(
    undefined
  );
  await request(app).get(`/api/v1/music/${id}/artwork`).expect(503);
});
it('rejects invalid identifiers without contacting the provider', async () => {
  const lookup = vi.spyOn(CoverArtArchive.prototype, 'getCoverArt');
  await request(app).get('/api/v1/music/invalid!id/artwork').expect(400);
  expect(lookup).not.toHaveBeenCalled();
});

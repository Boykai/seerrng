import Discogs from '@server/api/discogs';
import MusicBrainz from '@server/api/musicbrainz';
import TheAudioDb from '@server/api/theaudiodb';
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
    validateResponses: true,
    validateSecurity: false,
  })
);
app.use('/api/v1/music', musicRoutes);
afterEach(() => vi.restoreAllMocks());
const setup = () => {
  vi.spyOn(MusicBrainz.prototype, 'getReleaseGroupDetails').mockResolvedValue({
    id,
    title: 'Ray of Light',
    rating: { value: 4, 'votes-count': 12 },
    links: [
      { type: 'discogs', target: 'https://www.discogs.com/master/67803' },
    ],
  });
  vi.spyOn(TheAudioDb.prototype, 'getAlbumRating').mockResolvedValue({
    source: 'theaudiodb',
    score: 9,
    votes: 2,
    scale: 10,
    url: 'https://www.theaudiodb.com/album/2109828',
  });
  return vi.spyOn(Discogs.prototype, 'getAlbumRating').mockResolvedValue({
    source: 'discogs',
    score: 4.5,
    votes: 15,
    scale: 5,
    url: 'https://www.discogs.com/release/249504',
  });
};
it('returns each provider separately and preserves the legacy primary rating', async () => {
  const discogs = setup();
  const { body } = await request(app)
    .get(`/api/v1/music/${id}/rating`)
    .expect(200);
  expect(body.rating).toMatchObject({
    source: 'musicbrainz',
    score: 8,
    votes: 12,
  });
  expect(
    body.ratings.map((rating: { source: string }) => rating.source)
  ).toEqual(['musicbrainz', 'theaudiodb', 'discogs']);
  expect(body.failedSources).toEqual([]);
  expect(discogs).toHaveBeenCalledWith([
    { type: 'discogs', target: 'https://www.discogs.com/master/67803' },
  ]);
});
it('retains successful sources and signals a quiet retry for a failed provider', async () => {
  setup().mockRejectedValue(new Error('Temporary timeout'));
  const { body } = await request(app)
    .get(`/api/v1/music/${id}/rating`)
    .expect(200);
  expect(body.ratings).toHaveLength(2);
  expect(body.failedSources).toEqual(['discogs']);
});

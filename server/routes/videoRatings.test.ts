import ExternalAPI from '@server/api/externalapi';
import type { ParsedMdblistRatings } from '@server/api/mdblist';
import MdblistAPI from '@server/api/mdblist';
import IMDBRadarrProxy from '@server/api/rating/imdbRadarrProxy';
import RottenTomatoes from '@server/api/rating/rottentomatoes';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';
import movieRoutes from './movie';
import tvRoutes from './tv';

const movieDetails = {
  id: 123,
  title: 'Example Movie',
  release_date: '2020-01-01',
  imdb_id: 'tt1234567',
};
const tvDetails = {
  id: 456,
  name: 'Example Series',
  first_air_date: '2021-01-01',
};
const rtRatings = {
  title: 'Example',
  year: 2021,
  criticsRating: 'Fresh' as const,
  criticsScore: 82,
  audienceRating: 'Upright' as const,
  audienceScore: 90,
  url: 'https://www.rottentomatoes.com/m/example',
};
const mdblistRatings: ParsedMdblistRatings = {
  imdbId: 'tt1234567',
  imdbRating: 8.1,
  imdbVotes: 900,
  rtRating: 84,
  rtUserRating: 91,
  metacriticRating: 76,
  traktRating: 8.4,
  traktVotes: 1200,
  tmdbRating: 8.2,
};

let movieRtLookup: RottenTomatoes['getMovieRatings'];
let tvRtLookup: RottenTomatoes['getTVRatings'];
let imdbLookup: IMDBRadarrProxy['getMovieRatings'];
let mdblistLookup: MdblistAPI['getRatings'];
let mdblistBatchLookup: MdblistAPI['getBatchRatings'];
let lastBatchRequest: Parameters<MdblistAPI['getBatchRatings']> | undefined;
const externalApiPrototype = ExternalAPI.prototype as unknown as {
  get: (endpoint: string, ...args: unknown[]) => Promise<unknown>;
};

const app = () => {
  const instance = express();
  instance.use(express.json());
  instance.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateResponses: true,
      validateSecurity: false,
    })
  );
  instance.use('/api/v1/movie', movieRoutes);
  instance.use('/api/v1/tv', tvRoutes);
  instance.use(
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
  return instance;
};

describe('combined movie and TV ratings', () => {
  beforeEach(() => {
    movieRtLookup = async () => null;
    tvRtLookup = async () => null;
    imdbLookup = async () => null;
    mdblistLookup = async () => mdblistRatings;
    mdblistBatchLookup = async () =>
      new Map([
        [10, mdblistRatings],
        [20, null],
      ]);
    lastBatchRequest = undefined;
    mock.method(externalApiPrototype, 'get', async (endpoint: string) => {
      if (endpoint === '/movie/123') return movieDetails;
      if (endpoint === '/tv/456') return tvDetails;
      throw new Error(`Unexpected TMDB request: ${endpoint}`);
    });
    mock.method(
      RottenTomatoes.prototype,
      'getMovieRatings',
      (title: string, year: number) => movieRtLookup(title, year)
    );
    mock.method(
      RottenTomatoes.prototype,
      'getTVRatings',
      (title: string, year?: number) => tvRtLookup(title, year)
    );
    mock.method(
      IMDBRadarrProxy.prototype,
      'getMovieRatings',
      (imdbId: string) => imdbLookup(imdbId)
    );
    mock.method(
      MdblistAPI,
      'getInstance',
      () =>
        ({
          getRatings: (...args: Parameters<MdblistAPI['getRatings']>) =>
            mdblistLookup(...args),
          getBatchRatings: (
            ...args: Parameters<MdblistAPI['getBatchRatings']>
          ) => mdblistBatchLookup(...args),
        }) as unknown as MdblistAPI
    );
  });

  afterEach(() => mock.restoreAll());

  it('returns MDBList movie ratings when other rating providers have no values', async () => {
    const response = await request(app()).get(
      '/api/v1/movie/123/ratingscombined'
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { mdblist: mdblistRatings });
  });

  it('returns TV ratings through a combined endpoint without changing the legacy RT route', async () => {
    tvRtLookup = async () => rtRatings;
    const response = await request(app()).get('/api/v1/tv/456/ratingscombined');

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { rt: rtRatings, mdblist: mdblistRatings });
  });

  it('returns 502 when every configured provider fails instead of reporting a confirmed no-rating result', async () => {
    movieRtLookup = async () => {
      throw new Error('Rotten Tomatoes unavailable');
    };
    imdbLookup = async () => {
      throw new Error('IMDb unavailable');
    };
    mdblistLookup = async () => null;

    const response = await request(app()).get(
      '/api/v1/movie/123/ratingscombined'
    );

    assert.equal(response.status, 502);
    assert.match(response.body.message, /temporarily unavailable/);
  });

  it('batches at most 200 unique valid movie IDs and serializes provider results', async () => {
    mdblistBatchLookup = async (mediaType, items) => {
      lastBatchRequest = [mediaType, items];
      return new Map([
        [10, mdblistRatings],
        [20, null],
        [30, { imdbId: 'tt1234567' }],
      ]);
    };

    const response = await request(app())
      .post('/api/v1/movie/ratings/mdblist/batch')
      .send({ ids: [10, 20, 30, 10] });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { 10: mdblistRatings });
    assert.deepEqual(lastBatchRequest, [
      'movie',
      [{ tmdbId: 10 }, { tmdbId: 20 }, { tmdbId: 30 }],
    ]);
  });

  it('batches TV ratings through the series route', async () => {
    mdblistBatchLookup = async (mediaType, items) => {
      lastBatchRequest = [mediaType, items];
      return new Map([
        [10, mdblistRatings],
        [20, null],
      ]);
    };

    const response = await request(app())
      .post('/api/v1/tv/ratings/mdblist/batch')
      .send({ ids: [10, 20] });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { 10: mdblistRatings });
    assert.deepEqual(lastBatchRequest, [
      'tv',
      [{ tmdbId: 10 }, { tmdbId: 20 }],
    ]);
  });

  it('rejects an invalid movie rating batch', async () => {
    const response = await request(app())
      .post('/api/v1/movie/ratings/mdblist/batch')
      .send({ ids: [10, 0] });

    assert.equal(response.status, 400);
  });
});

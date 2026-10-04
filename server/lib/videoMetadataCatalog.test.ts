import ExternalAPI from '@server/api/externalapi';
import Tvdb from '@server/api/tvdb';
import type { TvdbVideoMetadataRecord } from '@server/api/tvdb/interfaces';
import TvmazeAPI from '@server/api/tvmaze';
import WikidataVideoMetadataAPI from '@server/api/wikidata/videoMetadata';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaSearchMetadata } from '@server/entity/MediaSearchMetadata';
import { VideoMetadataSourceRecord } from '@server/entity/VideoMetadataSourceRecord';
import { resetTestDb, seedTestDb } from '@server/utils/seedTestDb';
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import {
  getAggregatedMovieMetadata,
  getAggregatedTvMetadata,
  getVideoMetadataExpiry,
  normalizeVideoArtworkUrl,
  pruneExpiredVideoMetadata,
  VideoMetadataNotFoundError,
} from './videoMetadataCatalog';

const tmdbMovieId = 50123;

const tvdbRecord: TvdbVideoMetadataRecord = {
  id: 8801,
  name: 'Fallback Film',
  type: 'movie',
  overview: 'A summary from TheTVDB.',
  image: 'https://artworks.thetvdb.com/banners/movies/fallback-film.jpg',
  releaseDate: '2020-06-01',
  genres: [{ name: 'Thriller' }],
  companies: { production: [{ name: 'TVDB Studios' }] },
  remoteIds: [{ id: String(tmdbMovieId), sourceName: 'The Movie Database' }],
};

const mockPrivateMethod = mock.method as (
  object: object,
  methodName: string,
  implementation: (...args: unknown[]) => unknown
) => unknown;
const mockPrivate = (
  object: object,
  methodName: string,
  implementation: (...args: unknown[]) => unknown
) => mockPrivateMethod.call(mock, object, methodName, implementation);

describe('video metadata catalog', () => {
  before(async () => {
    await seedTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('accepts artwork only from the configured HTTPS providers', () => {
    assert.equal(
      normalizeVideoArtworkUrl('/banners/poster.jpg', 'tvdb'),
      'https://artworks.thetvdb.com/banners/poster.jpg'
    );
    assert.equal(
      normalizeVideoArtworkUrl(
        'https://static.tvmaze.com/uploads/poster.jpg',
        'tvmaze'
      ),
      'https://static.tvmaze.com/uploads/poster.jpg'
    );
    assert.equal(
      normalizeVideoArtworkUrl(
        'http://artworks.thetvdb.com/poster.jpg',
        'tvdb'
      ),
      undefined
    );
    assert.equal(
      normalizeVideoArtworkUrl(
        'https://artworks.thetvdb.com.attacker.invalid/poster.jpg',
        'tvdb'
      ),
      undefined
    );
    assert.equal(
      normalizeVideoArtworkUrl('https://attacker.invalid/poster.jpg', 'tvmaze'),
      undefined
    );
  });

  it('caps cached metadata at six calendar months', () => {
    assert.equal(
      getVideoMetadataExpiry(
        new Date('2026-01-31T10:15:00.000Z')
      ).toISOString(),
      '2026-07-31T10:15:00.000Z'
    );
    assert.equal(
      getVideoMetadataExpiry(
        new Date('2024-08-31T10:15:00.000Z')
      ).toISOString(),
      '2025-02-28T10:15:00.000Z'
    );
    assert.equal(
      getVideoMetadataExpiry(
        new Date('2024-02-29T10:15:00.000Z')
      ).toISOString(),
      '2024-08-29T10:15:00.000Z'
    );
  });

  it('merges independent source records when TMDB is unavailable and prunes them after expiry', async () => {
    mockPrivate(ExternalAPI.prototype, 'get', async () => {
      throw new Error('TMDB is offline');
    });

    const tvdb = {
      getVideoMetadataById: async () => tvdbRecord,
      getVideoMetadataByTmdbId: async () => tvdbRecord,
      searchVideoMetadata: async () => [tvdbRecord],
    } as unknown as Tvdb;
    mock.method(Tvdb, 'getInstance', async () => tvdb);

    mock.method(TvmazeAPI.prototype, 'searchShows', async () => []);
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'searchItemsByExternalId',
      async () => [{ id: 'Q201', label: 'Fallback Film' }]
    );
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'getVideoMetadata',
      async () => ({
        id: 'Q201',
        title: 'Fallback Film',
        overview: 'A Wikidata description.',
        releaseDate: '2020-06-01',
        genres: ['Drama'],
        directors: ['A. Director'],
        writers: ['B. Writer'],
        studios: ['Wikidata Pictures'],
        tmdbId: tmdbMovieId,
      })
    );

    const result = await getAggregatedMovieMetadata(tmdbMovieId, 'en-US');

    assert.equal(result.details.title, 'Fallback Film');
    assert.equal(result.details.overview, 'A summary from TheTVDB.');
    assert.deepEqual(
      result.details.genres.map(({ name }) => name),
      ['Thriller', 'Drama']
    );
    assert.deepEqual(
      result.details.production_companies.map(({ name }) => name),
      ['TVDB Studios', 'Wikidata Pictures']
    );
    assert.deepEqual(result.provenance.fields.overview, ['tvdb']);
    assert.equal(result.provenance.supplemental.posterUrl, tvdbRecord.image);
    assert.deepEqual(
      result.provenance.sources.map(({ source }) => source),
      ['tvdb', 'wikidata']
    );
    assert.equal(result.provenance.sources[0].license, 'Attribution required');
    assert.equal(result.provenance.sources[1].license, 'CC0');
    assert.deepEqual(result.provenance.supplemental.directors, ['A. Director']);

    const records = await getRepository(VideoMetadataSourceRecord).find();
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(
        record.expiresAt.toISOString(),
        getVideoMetadataExpiry(record.fetchedAt).toISOString()
      );
    }

    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: tmdbMovieId,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    await getRepository(MediaSearchMetadata).save({
      mediaId: media.id,
      title: 'Cached title',
      overview: 'Cached overview',
      posterPath: '/cached-poster.jpg',
      searchText: 'cached title cached overview',
      videoMetadataExpiresAt: records[0].expiresAt,
    });

    const removed = await pruneExpiredVideoMetadata(
      new Date(Date.now() + 7 * 31 * 24 * 60 * 60 * 1000)
    );
    assert.equal(removed, 3);
    assert.deepEqual(await getRepository(VideoMetadataSourceRecord).find(), []);
    const clearedSearchMetadata = await getRepository(
      MediaSearchMetadata
    ).findOneByOrFail({ mediaId: media.id });
    assert.equal(clearedSearchMetadata.title, null);
    assert.equal(clearedSearchMetadata.overview, null);
    assert.equal(clearedSearchMetadata.posterPath, '/cached-poster.jpg');
    assert.equal(clearedSearchMetadata.searchText, '');
    assert.equal(clearedSearchMetadata.videoMetadataExpiresAt, null);
  });

  it('upserts concurrent provider refreshes for the same source identity', async () => {
    mockPrivate(ExternalAPI.prototype, 'get', async () => ({
      id: tmdbMovieId,
      title: 'Fallback Film',
      original_title: 'Fallback Film',
      overview: 'A TMDB description.',
      release_date: '2020-06-01',
      genres: [],
      production_companies: [],
      credits: { cast: [], crew: [] },
      external_ids: { wikidata_id: 'Q201' },
    }));

    const tvdb = {
      getVideoMetadataByTmdbId: async () => tvdbRecord,
      searchVideoMetadata: async () => [tvdbRecord],
    } as unknown as Tvdb;
    mock.method(Tvdb, 'getInstance', async () => tvdb);

    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'searchItemsByExternalId',
      async () => [{ id: 'Q201', label: 'Fallback Film' }]
    );
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'getVideoMetadata',
      async () => ({
        id: 'Q201',
        title: 'Fallback Film',
        overview: 'A Wikidata description.',
        releaseDate: '2020-06-01',
        genres: ['Drama'],
        directors: [],
        writers: [],
        studios: [],
        tmdbId: tmdbMovieId,
      })
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        getAggregatedMovieMetadata(tmdbMovieId, 'en-US')
      )
    );
    assert.equal(results.length, 4);
    const records = await getRepository(VideoMetadataSourceRecord).find();
    assert.deepEqual(
      records.map(({ provider, sourceId }) => `${provider}:${sourceId}`).sort(),
      ['tmdb:50123:en-us', 'tvdb:8801', 'wikidata:Q201'].sort()
    );
  });

  it('reports a confirmed TMDB 404 as missing when no source has metadata', async () => {
    mockPrivate(ExternalAPI.prototype, 'get', async () => {
      throw Object.assign(new Error('TMDB not found'), {
        response: { status: 404 },
      });
    });

    const tvdb = {
      getVideoMetadataByTmdbId: async () => undefined,
      searchVideoMetadata: async () => [],
    } as unknown as Tvdb;
    mock.method(Tvdb, 'getInstance', async () => tvdb);
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'searchItemsByExternalId',
      async () => []
    );

    await assert.rejects(
      getAggregatedMovieMetadata(998814, 'en-US'),
      (error: unknown) => error instanceof VideoMetadataNotFoundError
    );
  });

  it('keeps provider outages distinct from confirmed missing titles', async () => {
    mockPrivate(ExternalAPI.prototype, 'get', async () => {
      throw Object.assign(new Error('TMDB unavailable'), {
        response: { status: 503 },
      });
    });

    const tvdb = {
      getVideoMetadataByTmdbId: async () => undefined,
      searchVideoMetadata: async () => [],
    } as unknown as Tvdb;
    mock.method(Tvdb, 'getInstance', async () => tvdb);
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'searchItemsByExternalId',
      async () => []
    );

    await assert.rejects(
      getAggregatedMovieMetadata(998815, 'en-US'),
      (error: unknown) =>
        error instanceof Error && !(error instanceof VideoMetadataNotFoundError)
    );
  });

  it('falls back to exact TVDB title and year matching after a direct ID lookup fails', async () => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 665,
        tvdbId: 991,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    await getRepository(MediaSearchMetadata).save({
      mediaId: media.id,
      title: 'Known Series',
      alternateTitle: 'Known Series Original',
      releaseDate: '2019-11-10',
      searchText: 'known series',
    });

    mockPrivate(ExternalAPI.prototype, 'get', async () => {
      throw new Error('TMDB is offline');
    });

    let titleSearchCalls = 0;
    const tvdb = {
      getVideoMetadataById: async () => {
        throw new Error('TVDB direct-ID endpoint failed');
      },
      getVideoMetadataByTmdbId: async () => undefined,
      searchVideoMetadata: async ({ query }: { query: string }) => {
        titleSearchCalls += 1;
        assert.equal(query, 'Known Series');
        return [
          {
            ...tvdbRecord,
            id: 992,
            name: 'Known Series',
            type: 'series',
            firstAired: '2019-11-10',
          },
          {
            ...tvdbRecord,
            id: 993,
            name: 'Known Series',
            type: 'series',
            firstAired: '2001-01-01',
          },
        ];
      },
    } as unknown as Tvdb;
    mock.method(Tvdb, 'getInstance', async () => tvdb);
    mock.method(
      TvmazeAPI.prototype,
      'getShowByExternalId',
      async () => undefined
    );
    mock.method(TvmazeAPI.prototype, 'searchShows', async () => []);
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'searchItemsByExternalId',
      async () => []
    );
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'searchItems',
      async () => []
    );

    const result = await getAggregatedTvMetadata(665, 'en-US');

    assert.equal(titleSearchCalls, 1);
    assert.equal(result.details.name, 'Known Series');
    assert.deepEqual(
      result.provenance.sources.map(({ source }) => source),
      ['tvdb']
    );
  });

  it('matches Wikidata TMDB identifiers for the requested media type', async () => {
    const seriesId = 667;
    mockPrivate(ExternalAPI.prototype, 'get', async () => {
      throw new Error('TMDB is offline');
    });

    const tvdb = {
      getVideoMetadataById: async () => undefined,
      getVideoMetadataByTmdbId: async () => undefined,
      searchVideoMetadata: async () => [],
    } as unknown as Tvdb;
    mock.method(Tvdb, 'getInstance', async () => tvdb);
    mock.method(TvmazeAPI.prototype, 'searchShows', async () => [
      {
        id: 55,
        name: 'Series from Wikidata',
        url: 'https://www.tvmaze.com/shows/55/series-from-wikidata',
        summary: '<p>TVmaze summary &amp; sound and &amp;lt;script&amp;gt;</p>',
        image: {
          original: 'https://static.tvmaze.com/uploads/poster.jpg',
        },
        premiered: '2018-04-01',
        genres: ['Comedy'],
        network: { name: 'TVmaze Network' },
      },
    ]);
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'searchItemsByExternalId',
      async ({ propertyId }: { propertyId: string }) => {
        assert.equal(propertyId, 'P4983');
        return [{ id: 'Q202', label: 'Series from Wikidata' }];
      }
    );
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'getVideoMetadata',
      async () => ({
        id: 'Q202',
        title: 'Series from Wikidata',
        genres: ['Drama'],
        directors: [],
        writers: [],
        studios: [],
        tmdbId: 123,
        tmdbMovieId: 123,
        tmdbTvId: seriesId,
      })
    );

    const result = await getAggregatedTvMetadata(seriesId, 'en-US');

    assert.equal(result.details.name, 'Series from Wikidata');
    assert.equal(result.details.id, seriesId);
    assert.equal(result.details.external_ids.wikidata_id, 'Q202');
    assert.equal(
      result.details.overview,
      'TVmaze summary & sound and &lt;script&gt;'
    );
    assert.deepEqual(
      result.details.networks.map(({ name }) => name),
      ['TVmaze Network']
    );
    assert.deepEqual(
      result.provenance.sources.map(({ source }) => source),
      ['tvmaze', 'wikidata']
    );
    assert.deepEqual(result.provenance.fields.overview, ['tvmaze']);
    assert.equal(
      result.provenance.supplemental.posterUrl,
      'https://static.tvmaze.com/uploads/poster.jpg'
    );
  });

  it('tries exact TVmaze title matching when its external-ID lookup fails', async () => {
    const seriesId = 668;
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: seriesId,
        tvdbId: 8891,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    await getRepository(MediaSearchMetadata).save({
      mediaId: media.id,
      title: 'TVmaze Fallback Series',
      releaseDate: '2021-02-03',
      searchText: 'tvmaze fallback series',
    });

    mockPrivate(ExternalAPI.prototype, 'get', async () => {
      throw new Error('TMDB is offline');
    });
    const tvdb = {
      getVideoMetadataById: async () => undefined,
      getVideoMetadataByTmdbId: async () => undefined,
      searchVideoMetadata: async () => [],
    } as unknown as Tvdb;
    mock.method(Tvdb, 'getInstance', async () => tvdb);
    mock.method(TvmazeAPI.prototype, 'getShowByExternalId', async () => {
      throw new Error('TVmaze has no record for this TVDB ID');
    });
    mock.method(TvmazeAPI.prototype, 'searchShows', async () => [
      {
        id: 8892,
        name: 'TVmaze Fallback Series',
        url: 'https://www.tvmaze.com/shows/8892/tvmaze-fallback-series',
        premiered: '2021-02-03',
        genres: ['Drama'],
      },
    ]);
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'searchItemsByExternalId',
      async () => []
    );
    mock.method(
      WikidataVideoMetadataAPI.prototype,
      'searchItems',
      async () => []
    );

    const result = await getAggregatedTvMetadata(seriesId, 'en-US');

    assert.equal(result.details.name, 'TVmaze Fallback Series');
    assert.deepEqual(
      result.provenance.sources.map(({ source }) => source),
      ['tvmaze']
    );
    assert.equal(result.provenance.sources[0].license, 'CC BY-SA 4.0');
  });
});

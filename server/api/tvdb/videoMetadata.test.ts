import ExternalAPI from '@server/api/externalapi';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import Tvdb from './index';

describe('TheTVDB remote-ID video lookup', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('uses the v4 remote-ID endpoint and filters to the requested media type', async () => {
    const tvdb = new Tvdb();
    mock.method(
      tvdb as unknown as object,
      'refreshToken',
      async () => undefined
    );
    const request = mock.method(
      ExternalAPI.prototype,
      'get',
      async () =>
        ({
          data: [
            { id: 10, name: 'A series', type: 'series' },
            { id: 20, name: 'A movie', type: 'movie' },
          ],
        }) as never
    );

    const result = await tvdb.getVideoMetadataByTmdbId({
      mediaType: 'movie',
      tmdbId: 456,
    });

    assert.equal(result?.id, 20);
    assert.equal(request.mock.calls[0].arguments[0], '/search/remoteid/456');
  });

  it('rejects an ambiguous same-type remote-ID match', async () => {
    const tvdb = new Tvdb();
    mock.method(
      tvdb as unknown as object,
      'refreshToken',
      async () => undefined
    );
    mock.method(
      ExternalAPI.prototype,
      'get',
      async () =>
        ({
          data: [
            { id: 20, name: 'First movie', type: 'movie' },
            { id: 21, name: 'Second movie', type: 'movie' },
          ],
        }) as never
    );

    const result = await tvdb.getVideoMetadataByTmdbId({
      mediaType: 'movie',
      tmdbId: 456,
    });

    assert.equal(result, undefined);
  });
});

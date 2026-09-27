import { AxiosError } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import MusicBrainz from './musicbrainz';
import PlexAPI from './plexapi';

const client = (response: unknown) => {
  const api = new PlexAPI({ plexToken: 'test' });
  const get = vi.fn().mockResolvedValue(response);
  const request = vi.fn().mockResolvedValue({});
  Object.defineProperty(api, 'get', { value: get });
  Object.defineProperty(api, 'request', { value: request });
  return { api, get, request };
};

describe('Plex collection adapter', () => {
  it('matches series by exact TMDB identity and requires downloaded episodes', async () => {
    const { api, get } = client({
      MediaContainer: {
        Metadata: [
          {
            type: 'show',
            ratingKey: '11',
            Guid: [{ id: 'tmdb://11' }],
            leafCount: 2,
          },
          {
            type: 'show',
            ratingKey: '12',
            Guid: [{ id: 'tmdb://11' }],
            leafCount: 0,
          },
        ],
      },
    });
    expect(
      (await api.findCollectionMovies('5', 11, 'show')).map(
        (item) => item.ratingKey
      )
    ).toEqual(['11']);
    expect(get.mock.calls[0][1].params.type).toBe(2);
  });
  it('matches album release groups and requires playable tracks, never title alone', async () => {
    const mbid = '11111111-1111-4111-8111-111111111111';
    const { api } = client({
      MediaContainer: {
        Metadata: [
          {
            type: 'album',
            ratingKey: '11',
            title: 'Album',
            Guid: [{ id: `mbid://${mbid}` }],
          },
          { type: 'album', ratingKey: '12', title: 'Album', Guid: [] },
        ],
      },
    });
    const children = vi
      .spyOn(api, 'getChildrenMetadata')
      .mockResolvedValue([
        { type: 'track', ratingKey: '20', Media: [{ audioCodec: 'mp3' }] },
      ] as never);
    expect(
      (await api.findCollectionAlbums('5', mbid, 'Album')).map(
        (item) => item.ratingKey
      )
    ).toEqual(['11']);
    children.mockResolvedValue([]);
    expect(await api.findCollectionAlbums('5', mbid, 'Album')).toEqual([]);
  });
  it('resolves a release ID to its exact album group', async () => {
    const mbid = '11111111-1111-4111-8111-111111111111';
    const { api } = client({
      MediaContainer: {
        Metadata: [
          {
            type: 'album',
            ratingKey: '11',
            Guid: [{ id: 'mbid://22222222-2222-4222-8222-222222222222' }],
          },
        ],
      },
    });
    const resolver = vi
      .spyOn(MusicBrainz.prototype, 'collectionReleaseGroup')
      .mockResolvedValue(mbid);
    vi.spyOn(api, 'getChildrenMetadata').mockResolvedValue([
      { type: 'track', ratingKey: '20', Media: [{ audioCodec: 'flac' }] },
    ] as never);
    try {
      expect(
        (await api.findCollectionAlbums('5', mbid, 'Album')).map(
          (item) => item.ratingKey
        )
      ).toEqual(['11']);
    } finally {
      resolver.mockRestore();
    }
  });
  it('resolves modern Plex IDs with read-only matching and rechecks the exact TMDB identity', async () => {
    const { api, get, request } = client({});
    get
      .mockResolvedValueOnce({ MediaContainer: { size: 0 } })
      .mockResolvedValueOnce({
        MediaContainer: { Metadata: [{ ratingKey: 'seed' }] },
      });
    // An invalid numeric seed must not be accepted.
    await expect(api.findCollectionMovies('5', 11)).rejects.toThrow('seed');
    expect(request).not.toHaveBeenCalled();
    const second = client({});
    second.get
      .mockResolvedValueOnce({ MediaContainer: { size: 0 } })
      .mockResolvedValueOnce({
        MediaContainer: { Metadata: [{ ratingKey: '10' }] },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          size: 1,
          SearchResult: [{ guid: 'plex://movie/abc' }],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            { type: 'movie', ratingKey: '11', Guid: [{ id: 'tmdb://11' }] },
          ],
        },
      });
    expect((await second.api.findCollectionMovies('5', 11))[0].ratingKey).toBe(
      '11'
    );
    expect(second.get.mock.calls[2][0]).toBe('/library/metadata/10/matches');
    expect(second.get.mock.calls[3][1].params.guid).toBe('plex://movie/abc');
    expect(second.request).not.toHaveBeenCalled();
  });
  it('accepts a section-scoped listing without repeated library IDs', async () => {
    const { api } = client({
      MediaContainer: {
        librarySectionID: 5,
        Metadata: [
          { type: 'collection', title: 'Collection', ratingKey: '90' },
        ],
      },
    });
    expect(
      (await api.findCollections('5', 'Collection'))[0].librarySectionID
    ).toBe('5');
  });
  it('deletes only a verified collection, never a movie endpoint', async () => {
    const { api, get, request } = client({});
    get
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              type: 'collection',
              title: 'Collection',
              ratingKey: '90',
              librarySectionID: 5,
            },
          ],
        },
      })
      .mockRejectedValueOnce(
        new AxiosError('not found', undefined, undefined, undefined, {
          status: 404,
        } as never)
      );
    await api.removeCollection('90', '5');
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'DELETE',
      '/library/collections/90'
    );
  });
  it('requires exact provider identity instead of accepting a same-title result', async () => {
    const { api, get } = client({
      MediaContainer: {
        Metadata: [
          {
            type: 'movie',
            ratingKey: '1',
            title: 'Same title',
            Guid: [{ id: 'tmdb://12' }],
          },
          {
            type: 'movie',
            ratingKey: '2',
            title: 'Correct movie',
            Guid: [{ id: 'tmdb://11' }],
          },
        ],
      },
    });
    expect(
      (await api.findCollectionMovies('5', 11)).map((item) => item.ratingKey)
    ).toEqual(['2']);
    expect(get.mock.calls[0][1].params).toEqual({
      type: 1,
      guid: 'tmdb://11',
      includeGuids: 1,
    });
  });
  it('does not interpret malformed metadata or a timeout as absence', async () => {
    const { api, get } = client({});
    await expect(api.getCollection('2')).rejects.toThrow('invalid');
    get.mockRejectedValue(new Error('timeout'));
    await expect(api.getCollection('2')).rejects.toThrow('timeout');
  });
  it('only treats a real 404 as a deleted collection', async () => {
    const { api, get } = client({});
    get.mockRejectedValue(
      new AxiosError('not found', undefined, undefined, undefined, {
        status: 404,
      } as never)
    );
    expect(await api.getCollection('2')).toBeNull();
    get.mockRejectedValue(
      new AxiosError('forbidden', undefined, undefined, undefined, {
        status: 403,
      } as never)
    );
    await expect(api.getCollection('2')).rejects.toThrow();
  });
  it('adds only absent members and preserves manually added members', async () => {
    const { api, request } = client({
      MediaContainer: { Metadata: [{ ratingKey: '1' }, { ratingKey: '99' }] },
    });
    await api.addCollectionItems('9', ['1', '2', '2'], 'server');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual([
      'PUT',
      '/library/collections/9/items',
      null,
      {
        params: {
          uri: 'server://server/com.plexapp.plugins.library/library/metadata/2',
        },
      },
    ]);
  });
});

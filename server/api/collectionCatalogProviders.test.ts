import { AxiosError } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import MusicBrainz from './musicbrainz';
import Tvdb from './tvdb';

const artistId = '11111111-1111-4111-8111-111111111111';
const albumId = '22222222-2222-4222-8222-222222222222';
const fakeGet = (client: object) => {
  const get = vi.fn();
  Object.defineProperty(client, 'get', { value: get });
  return get;
};

describe('collection metadata providers', () => {
  it('accepts only official TV lists, orders members and ignores movie-only entries', async () => {
    const api = new Tvdb();
    Object.defineProperty(api, 'refreshToken', {
      value: vi.fn().mockResolvedValue(undefined),
    });
    const get = fakeGet(api);
    get.mockResolvedValueOnce({
      data: {
        lists: [
          { id: 2, name: 'Official', isOfficial: true },
          { id: 3, name: 'Personal watchlist', isOfficial: false },
        ],
      },
    });
    expect(await api.getSeriesCollections(11)).toEqual([
      { id: 2, name: 'Official' },
    ]);
    get.mockResolvedValueOnce({
      data: {
        id: 2,
        name: 'Official',
        isOfficial: true,
        entities: [
          { seriesId: 12, order: 2 },
          { movieId: 4, order: 0 },
          { seriesId: 11, order: 1 },
          { seriesId: 12, order: 3 },
        ],
      },
    });
    expect((await api.getSeriesCollection(2)).seriesIds).toEqual([11, 12]);
    get.mockResolvedValueOnce({
      data: { id: 2, name: 'Personal', isOfficial: false, entities: [] },
    });
    await expect(api.getSeriesCollection(2)).rejects.toThrow('official');
  });
  it('rejects incomplete catalogues and keeps album groups, including compilations', async () => {
    const api = new MusicBrainz();
    const get = fakeGet(api);
    get
      .mockResolvedValueOnce({ id: artistId, name: 'Artist' })
      .mockResolvedValueOnce({
        'release-group-count': 2,
        'release-groups': [
          {
            id: albumId,
            title: 'Compilation',
            'primary-type': 'Album',
            'secondary-types': ['Compilation'],
            genres: [{ name: 'pop', count: 3 }],
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            title: 'Single',
            'primary-type': 'Single',
          },
        ],
      });
    expect(
      (await api.getArtistAlbumCollection(artistId)).albums.map(
        (album) => album.title
      )
    ).toEqual(['Compilation']);
    expect(get.mock.calls[1][1].params.inc).toContain('genres');
    get
      .mockResolvedValueOnce({ id: artistId, name: 'Artist' })
      .mockResolvedValueOnce({
        'release-group-count': 20,
        'release-groups': [],
      });
    await expect(api.getArtistAlbumCollection(artistId)).rejects.toThrow(
      'Incomplete'
    );
  });
  it('treats a missing release as a nonmatch but does not hide a provider outage', async () => {
    const api = new MusicBrainz();
    const get = fakeGet(api);
    get.mockRejectedValueOnce(
      new AxiosError('missing', undefined, undefined, undefined, {
        status: 404,
      } as never)
    );
    expect(await api.collectionReleaseGroup(albumId)).toBeNull();
    get.mockRejectedValueOnce(new Error('offline'));
    await expect(api.collectionReleaseGroup(albumId)).rejects.toThrow('verify');
  });
});

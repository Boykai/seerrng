import { MediaServerType } from '@server/constants/server';
import { getSettings } from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';
import JellyfinCollectionsAPI from './jellyfinCollections';

const client = (response: unknown) => {
  const api = new JellyfinCollectionsAPI('http://localhost:8096', 'test');
  const get = vi.fn().mockResolvedValue(response);
  const request = vi.fn().mockResolvedValue({ data: {} });
  Object.defineProperty(api, 'get', { value: get });
  Object.defineProperty(api, 'request', { value: request });
  return { api, get, request };
};
describe.each([MediaServerType.JELLYFIN, MediaServerType.EMBY])(
  'collection adapter type %s',
  (type) => {
    it('uses exact series and album provider identities instead of matching titles', async () => {
      getSettings().main.mediaServerType = type;
      const mbid = '11111111-1111-4111-8111-111111111111';
      const { api, get } = client({
        Items: [
          {
            Id: 'one',
            Type: 'Series',
            Name: 'Show',
            ProviderIds: { Tmdb: '11' },
          },
          {
            Id: 'two',
            Type: 'Series',
            Name: 'Show',
            ProviderIds: { Tmdb: '12' },
          },
        ],
      });
      expect(
        (await api.findCollectionMembers('tv', '11', 'tv', 'Show')).map(
          (item) => item.Id
        )
      ).toEqual(['one']);
      get.mockResolvedValue({
        Items: [
          {
            Id: 'album',
            Type: 'MusicAlbum',
            Name: 'Album',
            ProviderIds: { MusicBrainzReleaseGroup: mbid },
          },
          { Id: 'wrong', Type: 'MusicAlbum', Name: 'Album', ProviderIds: {} },
        ],
      });
      expect(
        (await api.findCollectionMembers('music', mbid, 'music', 'Album')).map(
          (item) => item.Id
        )
      ).toEqual(['album']);
    });
    it('requires exact provider IDs and excludes virtual movies', async () => {
      getSettings().main.mediaServerType = type;
      const { api, get } = client({
        Items: [
          {
            Id: 'one',
            Name: 'Same name',
            Type: 'Movie',
            ProviderIds: { Tmdb: '12' },
          },
          {
            Id: 'two',
            Name: 'Correct',
            Type: 'Movie',
            ProviderIds: { Tmdb: '11' },
          },
          {
            Id: 'virtual',
            Type: 'Movie',
            ProviderIds: { Tmdb: '11' },
            LocationType: 'Virtual',
          },
        ],
      });
      expect(
        (await api.findCollectionMovies('lib', 11)).map((item) => item.Id)
      ).toEqual(['two']);
      expect(get.mock.calls[0][1].params).toMatchObject({
        ParentId: 'lib',
        AnyProviderIdEquals: 'tmdb.11',
      });
    });
    it('never deletes a movie passed as a collection', async () => {
      const { api, request } = client({
        Items: [{ Id: 'movie', Type: 'Movie', Name: 'Movie' }],
      });
      await expect(api.removeCollection('movie')).rejects.toThrow(
        'not a collection'
      );
      expect(request).not.toHaveBeenCalled();
    });
    it('deletes only a verified BoxSet and verifies its disappearance', async () => {
      const { api, get, request } = client({ Items: [] });
      get.mockResolvedValueOnce({
        Items: [{ Id: 'box', Name: 'Collection', Type: 'BoxSet' }],
      });
      await api.removeCollection('box');
      expect(request).toHaveBeenCalledExactlyOnceWith(
        'DELETE',
        '/Items/box',
        null,
        { timeout: 8000 }
      );
    });
    it('does not treat an invalid response or access error as missing', async () => {
      const { api, get } = client({});
      await expect(api.getCollection('box')).rejects.toThrow('Unverified');
      get.mockRejectedValue(new Error('403'));
      await expect(api.getCollection('box')).rejects.toThrow('403');
    });
    it('preserves manual members and only adds missing IDs', async () => {
      const { api, get, request } = client({
        Items: [{ Id: 'movie1' }, { Id: 'manual' }],
      });
      get.mockResolvedValueOnce({
        Items: [{ Id: 'box', Name: 'Collection', Type: 'BoxSet' }],
      });
      await api.addCollectionItems('box', ['movie1', 'movie2', 'movie2']);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        'POST',
        '/Collections/box/Items',
        null,
        { params: { Ids: 'movie2' }, timeout: 8000 }
      );
    });
    it('creates through the collection endpoint, then verifies its type', async () => {
      const { api, request } = client({
        Items: [{ Id: 'box', Name: 'Collection', Type: 'BoxSet' }],
      });
      request.mockResolvedValue({ data: { Id: 'box' } });
      expect(await api.createCollection('Collection', ['movie'])).toEqual({
        id: 'box',
        title: 'Collection',
      });
      expect(request.mock.calls[0][1]).toBe('/Collections');
    });
  }
);

import { MediaServerType } from '@server/constants/server';
import { getSettings } from '@server/lib/settings';
import { afterEach, expect, it } from 'vitest';
import { getCollectionServer } from './collectionServers';

const settings = getSettings();
const original = {
  type: settings.main.mediaServerType,
  plex: settings.plex,
  jellyfin: settings.jellyfin,
};
afterEach(() => {
  settings.main.mediaServerType = original.type;
  settings.replaceSection('plex', original.plex);
  settings.replaceSection('jellyfin', original.jellyfin);
});

it.each([MediaServerType.PLEX, MediaServerType.JELLYFIN, MediaServerType.EMBY])(
  'uses normalized library types for every collection kind on server %s',
  (type) => {
    const libraries = [
      { id: 'mp3', name: 'MP3', type: 'music' as const, enabled: true },
      { id: 'flac', name: 'FLAC', type: 'music' as const, enabled: true },
      {
        id: 'disabled',
        name: 'Disabled',
        type: 'music' as const,
        enabled: false,
      },
      { id: 'books', name: 'Audiobooks', type: 'book' as const, enabled: true },
      { id: 'movies', name: 'Movies', type: 'movie' as const, enabled: true },
      { id: 'series', name: 'Series', type: 'show' as const, enabled: true },
    ];
    settings.main.mediaServerType = type;
    settings.replaceSection('plex', {
      ...settings.plex,
      machineId: 'test',
      libraries,
    });
    settings.replaceSection('jellyfin', {
      ...settings.jellyfin,
      serverId: 'test',
      apiKey: 'test',
      ip: 'localhost',
      port: 8096,
      libraries,
    });
    const owner = {
      plexToken: 'test',
      jellyfinUserId: 'test',
      jellyfinDeviceId: 'test',
    } as Parameters<typeof getCollectionServer>[0];
    expect(
      getCollectionServer(owner, 'music').libraries.map((library) => library.id)
    ).toEqual(['mp3', 'flac']);
    expect(
      getCollectionServer(owner, 'movie').libraries.map((library) => library.id)
    ).toEqual(['movies']);
    expect(
      getCollectionServer(owner, 'tv').libraries.map((library) => library.id)
    ).toEqual(['series']);
  }
);

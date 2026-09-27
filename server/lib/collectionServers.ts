import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import JellyfinCollectionsAPI from '@server/api/jellyfinCollections';
import PlexAPI, {
  type PlexCollection,
  type PlexLibraryItem,
} from '@server/api/plexapi';
import { MediaServerType } from '@server/constants/server';
import type { CollectionKind } from '@server/models/CuratedCollection';
import { getHostname } from '@server/utils/getHostname';
import type { MediaServerUserAuthoritySnapshot } from './mediaServerUserAuthority';
import { JellyfinScanner } from './scanners/jellyfin';
import { PlexScanner } from './scanners/plex';
import { getSettings } from './settings';

export interface CollectionMovie {
  id: string;
  title: string;
  qualities: boolean[];
  addedAt?: Date;
}
export interface RemoteCollection {
  id: string;
  title: string;
  libraryId: string;
  smart: boolean;
}
export interface CollectionServer {
  refreshMember?: (id: string) => Promise<void>;
  serverId: string;
  libraries: { id: string; name: string }[];
  targets: { id: string; name: string }[];
  targetForLibrary: (id: string) => string;
  findMovies: (libraryId: string, tmdbId: number) => Promise<CollectionMovie[]>;
  findMember?: (
    libraryId: string,
    id: string,
    title: string
  ) => Promise<CollectionMovie[]>;
  get: (id: string) => Promise<RemoteCollection | null>;
  find: (libraryId: string, title: string) => Promise<RemoteCollection[]>;
  create: (
    libraryId: string,
    title: string,
    ids: string[]
  ) => Promise<RemoteCollection>;
  add: (id: string, ids: string[]) => Promise<void>;
  remove: (id: string, libraryId: string) => Promise<void>;
}

const plexMovie = (item: PlexLibraryItem): CollectionMovie => ({
  id: item.ratingKey,
  title: item.title,
  qualities: [
    ...new Set(
      (item.Media ?? []).map((media) => media.videoResolution === '4k')
    ),
  ],
  addedAt: new Date(item.addedAt * 1000),
});
const jellyfinMovie = (item: JellyfinLibraryItemExtended): CollectionMovie => ({
  id: item.Id,
  title: item.Name,
  qualities: [
    ...new Set(
      (item.MediaSources ?? []).flatMap((source) =>
        (source.MediaStreams ?? [])
          .filter((stream) => stream.Type === 'Video' && !!stream.Width)
          .map((stream) => (stream.Width ?? 0) > 2000)
      )
    ),
  ],
  addedAt: item.DateCreated ? new Date(item.DateCreated) : undefined,
});

export const configuredCollectionServerId = (): string | undefined => {
  const settings = getSettings();
  if (settings.main.mediaServerType === MediaServerType.PLEX)
    return settings.plex.machineId;
  if (
    [MediaServerType.JELLYFIN, MediaServerType.EMBY].includes(
      settings.main.mediaServerType
    ) &&
    settings.jellyfin.serverId
  ) {
    return `${settings.main.mediaServerType}:${settings.jellyfin.serverId}`;
  }
};

export const getCollectionServer = (
  owner: MediaServerUserAuthoritySnapshot,
  kind: CollectionKind = 'movie'
): CollectionServer => {
  const settings = getSettings();
  const serverId = configuredCollectionServerId();
  if (!serverId) throw new Error('Media server is not configured.');
  if (settings.main.mediaServerType === MediaServerType.PLEX) {
    if (!owner.plexToken) throw new Error('Plex owner is not configured.');
    const api = new PlexAPI({
      plexToken: owner.plexToken,
      plexSettings: settings.plex,
      timeout: 8000,
    });
    const libraries = settings.plex.libraries.filter(
      (library) =>
        library.enabled &&
        library.type ===
          (kind === 'tv' ? 'show' : kind === 'music' ? 'music' : 'movie')
    );
    const convert = (item: PlexCollection): RemoteCollection => ({
      id: item.ratingKey,
      title: item.title,
      libraryId: item.librarySectionID,
      smart: item.smart,
    });
    return {
      serverId,
      refreshMember:
        kind === 'movie'
          ? undefined
          : (id) => new PlexScanner().refreshCollectionMember(id, kind),
      libraries,
      targets: libraries,
      targetForLibrary: (id) => id,
      findMovies: async (id, tmdbId) =>
        (await api.findCollectionMovies(id, tmdbId)).map(plexMovie),
      findMember: async (id, sourceId, title) =>
        (kind === 'music'
          ? await api.findCollectionAlbums(id, sourceId, title)
          : await api.findCollectionMovies(id, Number(sourceId), 'show')
        ).map(plexMovie),
      get: async (id) => {
        const item = await api.getCollection(id);
        return item ? convert(item) : null;
      },
      find: async (id, title) =>
        (await api.findCollections(id, title)).map(convert),
      create: async (id, title, keys) =>
        convert(
          await api.createCollection(
            title,
            id,
            keys,
            serverId,
            kind === 'tv' ? 'show' : kind === 'music' ? 'album' : 'movie'
          )
        ),
      add: (id, keys) => api.addCollectionItems(id, keys, serverId),
      remove: (id, libraryId) => api.removeCollection(id, libraryId),
    };
  }
  if (!settings.jellyfin.apiKey || !owner.jellyfinUserId)
    throw new Error('Media server owner is not configured.');
  const api = new JellyfinCollectionsAPI(
    getHostname(settings.jellyfin),
    settings.jellyfin.apiKey,
    owner.jellyfinDeviceId
  );
  api.setUserId(owner.jellyfinUserId);
  const libraries = settings.jellyfin.libraries.filter(
    (library) =>
      library.enabled &&
      library.type ===
        (kind === 'tv' ? 'show' : kind === 'music' ? 'music' : 'movie')
  );
  const convert = (item: { id: string; title: string }): RemoteCollection => ({
    ...item,
    libraryId: 'server',
    smart: false,
  });
  return {
    serverId,
    refreshMember:
      kind === 'movie'
        ? undefined
        : (id) => new JellyfinScanner().refreshCollectionMember(id, kind),
    libraries,
    targets: libraries.length
      ? [
          {
            id: 'server',
            name: `Server collection (all enabled ${kind === 'music' ? 'music' : kind === 'tv' ? 'series' : 'movie'} libraries)`,
          },
        ]
      : [],
    targetForLibrary: () => 'server',
    findMovies: async (id, tmdbId) =>
      (await api.findCollectionMovies(id, tmdbId)).map(jellyfinMovie),
    findMember: async (id, sourceId, title) =>
      (
        await api.findCollectionMembers(
          id,
          sourceId,
          kind === 'music' ? 'music' : 'tv',
          title
        )
      ).map(jellyfinMovie),
    get: async (id) => {
      const item = await api.getCollection(id);
      return item ? convert(item) : null;
    },
    find: async (_id, title) => (await api.findCollections(title)).map(convert),
    create: async (_id, title, keys) =>
      convert(await api.createCollection(title, keys)),
    add: (id, keys) => api.addCollectionItems(id, keys),
    remove: (id) => api.removeCollection(id),
  };
};

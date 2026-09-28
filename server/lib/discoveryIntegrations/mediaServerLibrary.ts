import type {
  JellyfinLibrary,
  JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import type { PlexLibrary, PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import type { DiscoveryAccountProvider } from '@server/entity/DiscoveryAccount';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { runWithConfigurationAdmission } from '@server/lib/configurationAdmission';
import { DiscoveryIntegrationError } from '@server/lib/discoveryIntegrations/accounts';
import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { getHostname } from '@server/utils/getHostname';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import { createHash } from 'node:crypto';
import type { LibraryShelf, PersonalLibraryItem } from './library';

export type NativeLibrarySource = 'plex' | 'jellyfin' | 'emby';
export type PersonalLibrarySource =
  DiscoveryAccountProvider | NativeLibrarySource;

export interface NativeLibraryOption {
  id: string;
  name: string;
  type: 'show' | 'movie';
}

export interface NativeLibraryConnection {
  provider: NativeLibrarySource;
  connected: boolean;
}

const PAGE_SIZE = 20;
const MAX_PAGE = 500;
const cacheFlights = new Map<string, Promise<unknown>>();

const sourceForConfiguredServer = (): NativeLibrarySource | undefined => {
  const serverType = getSettings().main.mediaServerType;
  if (serverType === MediaServerType.PLEX) return 'plex';
  if (serverType === MediaServerType.JELLYFIN) return 'jellyfin';
  if (serverType === MediaServerType.EMBY) return 'emby';
  return undefined;
};

const enabledVideoLibraries = (libraries: Library[]): NativeLibraryOption[] =>
  libraries
    .filter(
      (library) =>
        library.enabled &&
        (library.type === 'show' || library.type === 'movie') &&
        !!library.id &&
        !!library.name
    )
    .map((library) => ({
      id: library.id,
      name: library.name,
      type: library.type as 'show' | 'movie',
    }));

const boundedPositive = (value: unknown): number | undefined => {
  const id =
    typeof value === 'string' && /^\d{1,10}$/.test(value)
      ? Number(value)
      : value;
  return typeof id === 'number' &&
    Number.isSafeInteger(id) &&
    id > 0 &&
    id <= 2_147_483_647
    ? id
    : undefined;
};

const plexTmdbId = (item: PlexLibraryItem): number | undefined => {
  for (const guid of item.Guid ?? []) {
    const match = /^tmdb:\/\/(\d{1,10})$/.exec(guid.id);
    const id = match ? boundedPositive(match[1]) : undefined;
    if (id) return id;
  }
  return undefined;
};

const jellyfinTmdbId = (item: JellyfinLibraryItemExtended) =>
  boundedPositive(item.ProviderIds.Tmdb ?? item.ProviderIds.TheMovieDb);

const plexItem = (item: PlexLibraryItem): PersonalLibraryItem | undefined => {
  if (item.type !== 'movie' && item.type !== 'show') return undefined;
  const mediaType = item.type === 'movie' ? 'movie' : 'tv';
  const total = item.type === 'show' ? (item.leafCount ?? 0) : undefined;
  const watched =
    item.type === 'movie'
      ? (item.viewCount ?? 0) > 0
      : total !== undefined &&
        total > 0 &&
        (item.viewedLeafCount ?? 0) >= total;
  const progress = item.type === 'show' ? (item.viewedLeafCount ?? 0) : 0;
  const status: PersonalLibraryItem['status'] = watched
    ? 'completed'
    : item.type === 'show' && progress > 0
      ? 'watching'
      : 'unwatched';
  return {
    id: `plex:${mediaType}:${item.ratingKey}`,
    source: 'plex',
    sourceId: item.ratingKey,
    title: item.title,
    mediaType,
    tmdbId: plexTmdbId(item),
    year: item.year,
    status,
    ...(item.type === 'show' ? { progress, totalEpisodes: total } : {}),
  };
};

const jellyfinItem = (
  item: JellyfinLibraryItemExtended,
  source: 'jellyfin' | 'emby'
): PersonalLibraryItem | undefined => {
  if (item.Type !== 'Movie' && item.Type !== 'Series') return undefined;
  const mediaType = item.Type === 'Movie' ? 'movie' : 'tv';
  const userData = item.UserData;
  const isPartiallyPlayed =
    !userData?.Played &&
    ((userData?.PlaybackPositionTicks ?? 0) > 0 ||
      ((userData?.PlayedPercentage ?? 0) > 0 &&
        (userData?.PlayedPercentage ?? 0) < 100));
  return {
    id: `${source}:${mediaType}:${item.Id}`,
    source,
    sourceId: item.Id,
    title: item.Name,
    mediaType,
    tmdbId: jellyfinTmdbId(item),
    year: item.ProductionYear,
    status: userData?.Played
      ? 'completed'
      : isPartiallyPlayed
        ? 'watching'
        : 'unwatched',
  };
};

const statusMatchesShelf = (item: PersonalLibraryItem, shelf: LibraryShelf) => {
  switch (shelf) {
    case 'all':
      return true;
    case 'watched':
      return item.status === 'completed' || item.status === 'watched';
    case 'unwatched':
      return item.status !== 'completed' && item.status !== 'watched';
    case 'in-progress':
      return item.status === 'watching';
    default:
      return false;
  }
};

const cachedPersonalRead = async <T>(
  scope: unknown,
  operation: unknown,
  load: () => Promise<T>
): Promise<T> => {
  // The cache and single-flight keys are hashes; account credentials and
  // personal library contents never appear in cache keys or logs.
  const scopeHash = createHash('sha256')
    .update(JSON.stringify(scope))
    .digest('hex');
  const operationHash = createHash('sha256')
    .update(JSON.stringify(operation))
    .digest('hex');
  const key = `personal-library:${scopeHash}:${operationHash}`;
  const cache = cacheManager.getCache('personallibrary').data;
  const cached = cache.get<T>(key);
  if (cached !== undefined) return cached;
  const pending = cacheFlights.get(key);
  if (pending) return pending as Promise<T>;
  if (cacheFlights.size >= 256) {
    throw new DiscoveryIntegrationError(
      429,
      'Too many personal library requests are in progress.'
    );
  }
  const result = load();
  cacheFlights.set(key, result);
  try {
    const value = await result;
    cache.set(key, value, 30);
    return value;
  } finally {
    if (cacheFlights.get(key) === result) cacheFlights.delete(key);
  }
};

const validateShelfAndPage = (shelf: LibraryShelf, page: number) => {
  if (
    !['all', 'watched', 'unwatched', 'in-progress'].includes(shelf) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > MAX_PAGE
  ) {
    throw new DiscoveryIntegrationError(
      400,
      'Choose a valid media library shelf and page.'
    );
  }
};

export async function getNativeLibraryConnection(
  userId: number
): Promise<NativeLibraryConnection | null> {
  const source = sourceForConfiguredServer();
  if (!source) return null;
  const settings = getSettings();
  const configuredLibraries = enabledVideoLibraries(
    source === 'plex' ? settings.plex.libraries : settings.jellyfin.libraries
  );
  const hasConfiguredServer =
    source === 'plex'
      ? !!settings.plex.ip && configuredLibraries.length > 0
      : !!settings.jellyfin.ip && configuredLibraries.length > 0;
  if (!hasConfiguredServer) return null;
  const user = await getRepository(User).findOne({
    where: { id: userId },
    select: {
      id: true,
      plexToken: true,
      jellyfinUserId: true,
      jellyfinAuthToken: true,
    },
  });
  const connected =
    source === 'plex'
      ? !!user?.plexToken
      : !!user?.jellyfinAuthToken &&
        !!normalizeJellyfinGuid(user?.jellyfinUserId);
  return { provider: source, connected };
}

export async function personalMediaServerLibrary(
  userId: number,
  source: NativeLibrarySource,
  shelf: LibraryShelf,
  page: number,
  requestedLibraryId?: string
) {
  validateShelfAndPage(shelf, page);
  if (
    requestedLibraryId !== undefined &&
    (typeof requestedLibraryId !== 'string' ||
      requestedLibraryId.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(requestedLibraryId))
  ) {
    throw new DiscoveryIntegrationError(400, 'Invalid library selection.');
  }

  const configuredSource = sourceForConfiguredServer();
  if (configuredSource !== source) {
    throw new DiscoveryIntegrationError(
      409,
      'This media server is not configured for SeerrNG.'
    );
  }
  const section = source === 'plex' ? 'plex' : 'jellyfin';
  return runWithConfigurationAdmission(section, async () => {
    const currentSettings = getSettings();
    if (sourceForConfiguredServer() !== source) {
      throw new DiscoveryIntegrationError(
        409,
        'This media server is not configured for SeerrNG.'
      );
    }
    const configuredLibraries = enabledVideoLibraries(
      source === 'plex'
        ? currentSettings.plex.libraries
        : currentSettings.jellyfin.libraries
    );
    if (configuredLibraries.length === 0) {
      throw new DiscoveryIntegrationError(
        409,
        'No enabled movie or series libraries are configured.'
      );
    }

    const user = await getRepository(User).findOne({
      where: { id: userId },
      select: {
        id: true,
        plexToken: true,
        jellyfinUserId: true,
        jellyfinDeviceId: true,
        jellyfinAuthToken: true,
      },
    });
    if (source === 'plex' && !user?.plexToken) {
      throw new DiscoveryIntegrationError(
        409,
        'Link your Plex account to browse your personal library.'
      );
    }
    const jellyfinUserId = normalizeJellyfinGuid(user?.jellyfinUserId);
    if (source !== 'plex' && (!user?.jellyfinAuthToken || !jellyfinUserId)) {
      throw new DiscoveryIntegrationError(
        409,
        `Link your ${source === 'emby' ? 'Emby' : 'Jellyfin'} account to browse your personal library.`
      );
    }

    const config =
      source === 'plex' ? currentSettings.plex : currentSettings.jellyfin;
    const host =
      source === 'plex'
        ? `${config.useSsl ? 'https' : 'http'}://${config.ip}:${config.port}`
        : getHostname(currentSettings.jellyfin);
    const credential =
      source === 'plex' ? user!.plexToken! : user!.jellyfinAuthToken!;
    const cacheScope = [source, userId, credential, host, configuredLibraries];
    const cacheOperation = [requestedLibraryId ?? '', shelf, page];

    return cachedPersonalRead(cacheScope, cacheOperation, async () => {
      let libraries: NativeLibraryOption[];
      let items: PersonalLibraryItem[] = [];
      let total = 0;

      if (source === 'plex') {
        const api = new PlexAPI({
          plexToken: credential,
          plexSettings: currentSettings.plex,
        });
        const serverLibraries = await api.getLibraries();
        libraries = configuredLibraries.flatMap((configured) => {
          const visible = serverLibraries.find(
            (candidate: PlexLibrary) =>
              candidate.key === configured.id &&
              candidate.type === configured.type
          );
          return visible ? [configured] : [];
        });
        if (requestedLibraryId) {
          const library = libraries.find(
            (candidate) => candidate.id === requestedLibraryId
          );
          if (!library) {
            throw new DiscoveryIntegrationError(404, 'Library not found.');
          }
          const result = await api.getLibraryContents(library.id, {
            offset: (page - 1) * PAGE_SIZE,
            size: PAGE_SIZE,
            libraryType: library.type,
          });
          total = result.totalSize;
          items = result.items.flatMap((entry) => {
            const item = plexItem(entry);
            return item && statusMatchesShelf(item, shelf) ? [item] : [];
          });
        }
      } else {
        const api = new JellyfinAPI(
          getHostname(currentSettings.jellyfin),
          credential,
          user?.jellyfinDeviceId
        );
        api.setUserId(jellyfinUserId!);
        const serverLibraries = await api.getUserLibraries();
        libraries = configuredLibraries.filter((configured) =>
          serverLibraries.some(
            (candidate: JellyfinLibrary) =>
              candidate.key === configured.id &&
              candidate.type === configured.type
          )
        );
        if (requestedLibraryId) {
          const library = libraries.find(
            (candidate) => candidate.id === requestedLibraryId
          );
          if (!library) {
            throw new DiscoveryIntegrationError(404, 'Library not found.');
          }
          const result = await api.getUserLibraryContents(
            library.id,
            library.type,
            {
              offset: (page - 1) * PAGE_SIZE,
              size: PAGE_SIZE,
              ...(shelf === 'watched'
                ? { isPlayed: true }
                : shelf === 'unwatched'
                  ? { isPlayed: false }
                  : {}),
            }
          );
          total = result.TotalRecordCount;
          items = result.Items.flatMap((entry) => {
            const item = jellyfinItem(entry, source);
            return item && statusMatchesShelf(item, shelf) ? [item] : [];
          });
        }
      }

      const hasMore = page * PAGE_SIZE < total;
      return {
        items,
        libraries,
        page,
        total,
        hasMore: hasMore && page < MAX_PAGE,
        allowWrites: false,
        missingMappings: items.filter((item) => !item.tmdbId).length,
        truncated: hasMore && page === MAX_PAGE,
      };
    });
  });
}

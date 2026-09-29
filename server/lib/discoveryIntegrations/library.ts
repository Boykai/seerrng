import type { TraktListEntry } from '@server/api/trakt/interfaces';
import type { DiscoveryAccountProvider } from '@server/entity/DiscoveryAccount';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import {
  DiscoveryIntegrationError,
  getAnilistClient,
  getSimklClient,
  getTraktClient,
  requireDiscoveryAccount,
} from './accounts';
import { cachedAccountRead } from './cache';
import { applyCuratedIdentityMappings } from './curatedIdentityPacks';
import {
  resolveExternalIdentityMatches,
  toPublicIdentityCandidate,
} from './externalIdentityResolver';
import {
  applyPersonalIdentityMappings,
  type ExternalIdentityMappingMatch,
} from './identityMappings';
import type { NativeLibrarySource } from './mediaServerLibrary';

export interface PersonalLibraryItem {
  id: string;
  source: DiscoveryAccountProvider | NativeLibrarySource;
  sourceId: string;
  title: string;
  mediaType?: 'movie' | 'tv';
  tmdbId?: number;
  imageUrl?: string;
  year?: number;
  status?:
    | 'planning'
    | 'watching'
    | 'watched'
    | 'completed'
    | 'unwatched'
    | 'paused'
    | 'dropped';
  rating?: number;
  progress?: number;
  totalEpisodes?: number;
  identityMapped?: boolean;
  identityResolution?: 'personal' | 'curated' | 'external-id';
  /** Internal resolver inputs; removed before the API response is serialized. */
  imdbId?: string;
  tvdbId?: number;
}
export type LibraryShelf =
  | 'all'
  | 'watchlist'
  | 'watched'
  | 'unwatched'
  | 'in-progress'
  | 'completed'
  | 'rated';
export const MAX_PROVIDER_LIBRARY_REPAIR_PAGES_PER_BATCH = 5;

const positive = (value: unknown): number | undefined => {
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) &&
    Number(number) > 0 &&
    Number(number) <= 2147483647
    ? Number(number)
    : undefined;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const score = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > 0 &&
  value <= 10
    ? value
    : undefined;
const count = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100000
    ? Number(value)
    : undefined;
function traktItem(
  row: TraktListEntry,
  mediaType: 'movie' | 'tv'
): PersonalLibraryItem | undefined {
  const metadata = mediaType === 'movie' ? row.movie : row.show;
  const sourceId = positive(metadata?.ids?.trakt);
  if (!sourceId || !metadata?.title) return;
  return {
    id: `trakt:${mediaType}:${sourceId}`,
    source: 'trakt',
    sourceId: String(sourceId),
    mediaType,
    title: metadata.title.slice(0, 1000),
    tmdbId: positive(metadata.ids?.tmdb),
    ...(metadata.ids?.imdb ? { imdbId: metadata.ids.imdb } : {}),
    ...(positive(metadata.ids?.tvdb)
      ? { tvdbId: positive(metadata.ids?.tvdb) }
      : {}),
    year: positive(metadata.year),
  };
}
async function traktLibrary(
  userId: number,
  shelf: LibraryShelf,
  page: number,
  mediaType: 'movie' | 'tv'
) {
  if (!['watched', 'watchlist', 'rated'].includes(shelf))
    throw new DiscoveryIntegrationError(
      400,
      'Choose Watched, Watchlist, or Rated for Trakt.'
    );
  const api = await getTraktClient(userId);
  await api.prepareAccessToken();
  const account = await requireDiscoveryAccount(userId, 'trakt');
  return cachedAccountRead(
    account,
    `library:trakt:${shelf}:${mediaType}:${page}`,
    async () => {
      if (shelf === 'watchlist') {
        const fetched = await api.getWatchlistItems('me', mediaType, {
          page,
          limit: 20,
        });
        return {
          items: fetched.items.map((row): PersonalLibraryItem => ({
            id: `trakt:${row.mediaType}:${row.traktId}`,
            source: 'trakt',
            sourceId: String(row.traktId ?? ''),
            title: row.title.slice(0, 1000),
            mediaType: row.mediaType,
            tmdbId: positive(row.tmdbId),
            ...(row.imdbId ? { imdbId: row.imdbId } : {}),
            ...(positive(row.tvdbId) ? { tvdbId: positive(row.tvdbId) } : {}),
            year: positive(row.year),
            status: 'planning',
          })),
          hasMore: fetched.hasMore,
        };
      }
      const fetched = await api.getSyncLibraryPage(
        mediaType,
        shelf === 'rated' ? 'ratings' : 'watched',
        page,
        20
      );
      const items = fetched.flatMap((row) => {
        const item = traktItem(row, mediaType);
        if (!item) return [];
        item.rating = score(row.rating);
        if (shelf === 'watched') {
          item.status = mediaType === 'movie' ? 'completed' : 'watched';
          if (mediaType === 'tv') {
            const episodes = new Set<string>();
            for (const season of (row.seasons ?? []).slice(0, 10000))
              for (const episode of (season.episodes ?? []).slice(0, 100000))
                if ((episode.plays ?? 0) > 0)
                  episodes.add(`${season.number}:${episode.number}`);
            item.progress = episodes.size;
          }
        }
        return [item];
      });
      return { items, hasMore: fetched.length === 20 };
    }
  );
}
async function anilistLibrary(userId: number): Promise<PersonalLibraryItem[]> {
  const account = await requireDiscoveryAccount(userId, 'anilist');
  const api = await getAnilistClient(userId);
  return cachedAccountRead(account, 'library:anilist', async () => {
    const viewer = await api.getViewer();
    const collection = await api.getMediaListCollection(viewer.id);
    const items = new Map<string, PersonalLibraryItem>();
    const statuses = {
      CURRENT: 'watching',
      REPEATING: 'watching',
      PLANNING: 'planning',
      COMPLETED: 'completed',
      PAUSED: 'paused',
      DROPPED: 'dropped',
    } as const;
    if (
      collection.lists.length > 100 ||
      collection.lists.some((list) => (list.entries?.length ?? 0) > 10000)
    )
      throw new DiscoveryIntegrationError(
        502,
        'Your anime library exceeds the supported snapshot limit.'
      );
    for (const list of collection.lists)
      for (const entry of (list.entries ?? []).slice(0, 10000)) {
        const media = entry.media;
        if (!media || !positive(media.id)) continue;
        const image = media.coverImage?.large ?? media.coverImage?.medium;
        const id = `anilist:${media.id}`;
        items.set(id, {
          id,
          source: 'anilist',
          sourceId: String(media.id),
          title: api.mediaTitle(media).slice(0, 1000),
          mediaType: media.format === 'MOVIE' ? 'movie' : 'tv',
          year: positive(media.seasonYear),
          imageUrl:
            image && /^https:\/\/s4\.anilist\.co\//.test(image)
              ? image
              : undefined,
          status: entry.status ? statuses[entry.status] : undefined,
          rating: score(entry.score),
          progress: count(entry.progress),
          totalEpisodes: count(media.episodes),
        });
        if (items.size > 10000)
          throw new DiscoveryIntegrationError(
            502,
            'Your anime library exceeds the supported snapshot limit.'
          );
      }
    return [...items.values()];
  });
}
async function simklLibrary(userId: number): Promise<PersonalLibraryItem[]> {
  const account = await requireDiscoveryAccount(userId, 'simkl');
  const api = await getSimklClient(userId);
  return cachedAccountRead(account, 'library:simkl', async () => {
    const response = await api.getAllItems(undefined, { extended: 'full' });
    const items: PersonalLibraryItem[] = [];
    const statuses: Record<string, PersonalLibraryItem['status']> = {
      watching: 'watching',
      plantowatch: 'planning',
      hold: 'paused',
      completed: 'completed',
      dropped: 'dropped',
    };
    for (const namespace of ['movies', 'shows', 'anime'] as const)
      for (const raw of Array.isArray(response[namespace])
        ? (response[namespace] as unknown[])
        : []) {
        const row = object(raw);
        const metadata = object(row.movie ?? row.show);
        const ids = object(metadata.ids);
        const sourceId = positive(ids.simkl);
        if (!sourceId || typeof metadata.title !== 'string') continue;
        // Anime TMDB IDs can name a film or series. Keep native identity until the mapping layer confirms its type.
        const mediaType =
          namespace === 'movies'
            ? ('movie' as const)
            : namespace === 'shows'
              ? ('tv' as const)
              : undefined;
        items.push({
          id: `simkl:${namespace}:${sourceId}`,
          source: 'simkl',
          sourceId: String(sourceId),
          title: metadata.title.slice(0, 1000),
          mediaType,
          tmdbId: mediaType ? positive(ids.tmdb) : undefined,
          ...(typeof ids.imdb === 'string' && /^tt\d{1,20}$/.test(ids.imdb)
            ? { imdbId: ids.imdb }
            : {}),
          ...(positive(ids.tvdb) ? { tvdbId: positive(ids.tvdb) } : {}),
          year: positive(metadata.year),
          status: statuses[String(row.status)],
          rating: score(row.user_rating),
          progress: count(row.watched_episodes_count),
          totalEpisodes: count(row.total_episodes_count),
        });
        if (items.length > 10000)
          throw new DiscoveryIntegrationError(
            502,
            'Your Simkl library exceeds the supported snapshot limit.'
          );
      }
    return items;
  });
}
export async function personalProviderLibrary(
  userId: number,
  provider: DiscoveryAccountProvider,
  shelf: LibraryShelf,
  page: number,
  mediaType?: 'movie' | 'tv'
) {
  if (
    ![
      'all',
      'watchlist',
      'watched',
      'in-progress',
      'completed',
      'rated',
    ].includes(shelf) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 500
  )
    throw new DiscoveryIntegrationError(
      400,
      'Choose a valid library shelf and page.'
    );
  await requireDiscoveryAccount(userId, provider);
  if (provider === 'trakt') {
    const mediaTypes = mediaType
      ? isMediaCategoryEnabled(mediaType)
        ? [mediaType]
        : []
      : (['movie', 'tv'] as const).filter(isMediaCategoryEnabled);
    if (!mediaTypes.length)
      return {
        items: [] as PersonalLibraryItem[],
        page,
        hasMore: false,
        allowWrites: false,
        missingMappings: 0,
        truncated: false,
      };
    const results = [];
    for (const type of mediaTypes)
      results.push(await traktLibrary(userId, shelf, page, type));
    const providerHasMore = results.some((result) => result.hasMore);
    const result = {
      items: results.flatMap((result) => result.items),
      hasMore: providerHasMore,
      truncated: providerHasMore && page === 500,
    };
    const current = await requireDiscoveryAccount(userId, provider);
    const personalItems = await applyPersonalIdentityMappings(
      userId,
      result.items
    );
    const curatedItems = await applyCuratedIdentityMappings(personalItems);
    const items = await resolveExternalIdentityMatches(curatedItems);
    return {
      ...result,
      items: items.map(toPublicIdentityCandidate),
      hasMore: providerHasMore && page < 500,
      page,
      allowWrites: current.allowWrites,
      missingMappings: items.filter((item) => !item.tmdbId || !item.mediaType)
        .length,
    };
  }
  const snapshot =
    provider === 'anilist'
      ? await anilistLibrary(userId)
      : await simklLibrary(userId);
  const manuallyMappedSnapshot = await applyPersonalIdentityMappings(
    userId,
    snapshot
  );
  const curatedMappedSnapshot = await applyCuratedIdentityMappings(
    manuallyMappedSnapshot
  );
  const items = curatedMappedSnapshot
    .filter(
      (item) =>
        (item.mediaType
          ? isMediaCategoryEnabled(item.mediaType)
          : isMediaCategoryEnabled('movie') || isMediaCategoryEnabled('tv')) &&
        (!mediaType || item.mediaType === mediaType) &&
        (shelf === 'all' ||
          (shelf === 'watchlist' && item.status === 'planning') ||
          (shelf === 'watched' &&
            ['watched', 'completed', 'watching'].includes(item.status ?? '')) ||
          (shelf === 'in-progress' && item.status === 'watching') ||
          (shelf === 'completed' && item.status === 'completed') ||
          (shelf === 'rated' && item.rating !== undefined))
    )
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const pageItems = items.slice((page - 1) * 20, page * 20);
  const resolvedPageItems = await resolveExternalIdentityMatches(pageItems);
  const visiblePageItems = resolvedPageItems.filter((item) =>
    item.mediaType
      ? isMediaCategoryEnabled(item.mediaType)
      : isMediaCategoryEnabled('movie') || isMediaCategoryEnabled('tv')
  );
  const unresolvedBeforePage = pageItems.filter(
    (item) => !item.tmdbId || !item.mediaType
  ).length;
  const missingMappings =
    items.filter((item) => !item.tmdbId || !item.mediaType).length -
    unresolvedBeforePage +
    visiblePageItems.filter((item) => !item.tmdbId || !item.mediaType).length;
  return {
    items: visiblePageItems.map(toPublicIdentityCandidate),
    page,
    total: items.length,
    truncated: false,
    hasMore: page * 20 < items.length,
    allowWrites: (await requireDiscoveryAccount(userId, provider)).allowWrites,
    missingMappings,
  };
}

export async function resolvePersonalProviderLibraryMappings(
  userId: number,
  provider: DiscoveryAccountProvider,
  shelf: LibraryShelf,
  startPage: number,
  pageCount: number,
  mediaType?: 'movie' | 'tv'
) {
  if (
    !['trakt', 'anilist', 'simkl'].includes(provider) ||
    !Number.isSafeInteger(startPage) ||
    startPage < 1 ||
    startPage > 500 ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    pageCount > MAX_PROVIDER_LIBRARY_REPAIR_PAGES_PER_BATCH
  )
    throw new DiscoveryIntegrationError(
      400,
      'Choose a valid provider library scan range.'
    );

  let scanned = 0;
  let pagesScanned = 0;
  let page = startPage;
  let hasMore = true;
  let truncated = false;
  const exactMatches = new Map<string, ExternalIdentityMappingMatch>();
  const ambiguous = new Set<string>();
  while (page < startPage + pageCount && page <= 500) {
    const result = await personalProviderLibrary(
      userId,
      provider,
      shelf,
      page,
      mediaType
    );
    pagesScanned += 1;
    scanned += result.items.length;
    for (const item of result.items) {
      if (
        item.identityResolution !== 'external-id' ||
        !item.tmdbId ||
        !item.mediaType
      )
        continue;
      const candidate = {
        identity: item.id,
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
      };
      const previous = exactMatches.get(candidate.identity);
      if (
        previous &&
        (previous.tmdbId !== candidate.tmdbId ||
          previous.mediaType !== candidate.mediaType)
      ) {
        exactMatches.delete(candidate.identity);
        ambiguous.add(candidate.identity);
      } else if (!ambiguous.has(candidate.identity)) {
        exactMatches.set(candidate.identity, candidate);
      }
    }

    truncated ||= result.truncated;
    hasMore = result.hasMore || result.truncated;
    if (!hasMore || result.truncated) break;
    page += 1;
  }

  const matches = [...exactMatches.values()];
  const nextPage = truncated ? 500 : hasMore ? page : page + 1;
  return {
    startPage,
    nextPage,
    pagesScanned,
    scanned,
    matches,
    matched: matches.length,
    hasMore: hasMore && !truncated && nextPage <= 500,
    truncated,
  };
}

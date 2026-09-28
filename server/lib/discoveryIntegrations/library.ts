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

export interface PersonalLibraryItem {
  id: string;
  source: DiscoveryAccountProvider;
  sourceId: string;
  title: string;
  mediaType?: 'movie' | 'tv';
  tmdbId?: number;
  imageUrl?: string;
  year?: number;
  status?:
    'planning' | 'watching' | 'watched' | 'completed' | 'paused' | 'dropped';
  rating?: number;
  progress?: number;
  totalEpisodes?: number;
}
export type LibraryShelf =
  'all' | 'watchlist' | 'watched' | 'in-progress' | 'completed' | 'rated';
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
    if (!isMediaCategoryEnabled(mediaType ?? 'movie'))
      return {
        items: [] as PersonalLibraryItem[],
        page,
        hasMore: false,
        allowWrites: false,
        missingMappings: 0,
        truncated: false,
      };
    const result = await traktLibrary(
      userId,
      shelf,
      page,
      mediaType ?? 'movie'
    );
    const current = await requireDiscoveryAccount(userId, provider);
    return {
      ...result,
      hasMore: result.hasMore && page < 500,
      truncated: result.hasMore && page === 500,
      page,
      allowWrites: current.allowWrites,
      missingMappings: result.items.filter((item) => !item.tmdbId).length,
    };
  }
  const snapshot =
    provider === 'anilist'
      ? await anilistLibrary(userId)
      : await simklLibrary(userId);
  const items = snapshot
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
  return {
    items: items.slice((page - 1) * 20, page * 20),
    page,
    total: items.length,
    truncated: false,
    hasMore: page * 20 < items.length,
    allowWrites: (await requireDiscoveryAccount(userId, provider)).allowWrites,
    missingMappings: items.filter((item) => !item.tmdbId || !item.mediaType)
      .length,
  };
}

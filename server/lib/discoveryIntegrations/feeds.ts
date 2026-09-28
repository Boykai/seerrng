import AnilistAPI from '@server/api/anilist';
import type { AnilistMedia } from '@server/api/anilist/interfaces';
import MdblistAPI from '@server/api/mdblist';
import { parseMdblistListRef } from '@server/api/mdblist/lists';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import {
  DiscoveryIntegrationError,
  getAnilistClient,
  getTraktClient,
  requireDiscoveryAccount,
} from './accounts';
import { cachedAccountRead } from './cache';

export interface DiscoveryFeedItem {
  id: string;
  source: 'trakt' | 'anilist' | 'mdblist';
  sourceId: string;
  title: string;
  mediaType?: 'movie' | 'tv';
  tmdbId?: number;
  year?: number;
  imageUrl?: string;
}
export interface DiscoveryFeedPage {
  page: number;
  hasMore: boolean;
  items: DiscoveryFeedItem[];
  missingMappings: number;
}
function anilistItem(item: AnilistMedia): DiscoveryFeedItem {
  const image = item.coverImage?.large ?? item.coverImage?.medium;
  return {
    id: `anilist:${item.id}`,
    source: 'anilist',
    sourceId: String(item.id),
    title:
      item.title?.english ??
      item.title?.romaji ??
      item.title?.native ??
      String(item.id),
    mediaType: item.format === 'MOVIE' ? 'movie' : 'tv',
    year: item.seasonYear ?? undefined,
    imageUrl:
      image && /^https:\/\/s4\.anilist\.co\//.test(image) ? image : undefined,
  };
}
export async function discoveryFeed(
  userId: number,
  provider: string,
  feed: string,
  page: number,
  list?: string
): Promise<DiscoveryFeedPage> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100)
    throw new DiscoveryIntegrationError(400, 'Page must be between 1 and 100.');
  let items: DiscoveryFeedItem[];
  let hasMore: boolean;
  if (provider === 'trakt') {
    if (
      ![
        'watchlist',
        'history',
        'recommendations-movie',
        'recommendations-tv',
      ].includes(feed)
    )
      throw new DiscoveryIntegrationError(400, 'Unknown Trakt feed.');
    const api = await getTraktClient(userId);
    const fetched =
      feed === 'watchlist'
        ? await api.getWatchlistItems('me', 'all', { page, limit: 20 })
        : feed === 'history'
          ? await api.getHistoryItems('all', { page, limit: 20 })
          : feed === 'recommendations-movie' || feed === 'recommendations-tv'
            ? {
                items:
                  page === 1
                    ? await api.getRecommendations(
                        feed === 'recommendations-movie' ? 'movie' : 'tv',
                        { limit: 20 }
                      )
                    : [],
                hasMore: false,
              }
            : null;
    if (!fetched)
      throw new DiscoveryIntegrationError(400, 'Unknown Trakt feed.');
    hasMore = fetched.hasMore;
    items = fetched.items.map((item, index) => ({
      id: `trakt:${item.mediaType}:${item.traktId ?? item.tmdbId ?? index}`,
      source: 'trakt',
      sourceId: String(item.traktId ?? item.traktSlug ?? ''),
      title: item.title,
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      year: item.year,
    }));
  } else if (provider === 'anilist') {
    const api = new AnilistAPI();
    if (feed === 'library') {
      const client = await getAnilistClient(userId);
      const viewer = await client.getViewer();
      const account = await requireDiscoveryAccount(userId, 'anilist');
      const collection = await cachedAccountRead(account, 'library', () =>
        client.getMediaListCollection(viewer.id)
      );
      const unique = new Map<number, AnilistMedia>();
      for (const group of collection.lists)
        for (const entry of group.entries ?? [])
          if (entry.media) unique.set(entry.media.id, entry.media);
      const media = [...unique.values()];
      hasMore = page * 20 < media.length;
      items = media.slice((page - 1) * 20, page * 20).map(anilistItem);
    } else {
      const fetched =
        feed === 'trending'
          ? await api.getTrending(page)
          : feed === 'popular'
            ? await api.getPopular(page)
            : feed === 'top'
              ? await api.getTop(page)
              : feed === 'next-season'
                ? await api.getNextSeason(page)
                : null;
      if (!fetched)
        throw new DiscoveryIntegrationError(400, 'Unknown AniList feed.');
      hasMore = fetched.pageInfo.hasNextPage === true;
      items = fetched.media.map(anilistItem);
    }
  } else if (provider === 'mdblist' && feed === 'list') {
    if (!list || list.length > 2048)
      throw new DiscoveryIntegrationError(
        400,
        'Enter an MDBList URL or list ID.'
      );
    try {
      parseMdblistListRef(list);
    } catch {
      throw new DiscoveryIntegrationError(
        400,
        'Invalid MDBList URL or list ID.'
      );
    }
    const fetched = await MdblistAPI.getInstance().getListItems(list, {
      limit: 20,
      offset: (page - 1) * 20,
    });
    hasMore = fetched.hasMore;
    items = fetched.items.map((item, index) => ({
      id: `mdblist:${item.mediaType ?? 'unknown'}:${item.tmdbId ?? item.imdbId ?? index}`,
      source: 'mdblist',
      sourceId: String(item.imdbId ?? item.tmdbId ?? ''),
      title: item.title,
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
    }));
  } else
    throw new DiscoveryIntegrationError(
      400,
      'Unknown discovery provider or feed.'
    );
  items = items.filter(
    (item) => !item.mediaType || isMediaCategoryEnabled(item.mediaType)
  );
  return {
    page,
    hasMore,
    items,
    missingMappings: items.filter((item) => !item.tmdbId || !item.mediaType)
      .length,
  };
}

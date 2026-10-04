import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';

// The watchlist APIs return 20 items a page. Loading the manga of one page
// together keeps each request unchanged while later pages load, and stays
// within the 50-title limit of GET /api/v1/manga?ids=.
const WATCHLIST_PAGE_SIZE = 20;

type WatchlistEntry = Pick<WatchlistItem, 'mediaType' | 'externalId'>;

export const getMangaWatchlistId = (
  item: WatchlistEntry
): number | undefined => {
  if (item.mediaType !== 'manga' || !/^\d+$/.test(item.externalId ?? '')) {
    return undefined;
  }
  const id = Number(item.externalId);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

/** The AniList IDs of the manga on the same watchlist page as an item. */
export const getMangaWatchlistBatch = (
  items: readonly WatchlistEntry[],
  index: number
): number[] => {
  const start = index - (index % WATCHLIST_PAGE_SIZE);
  return items.slice(start, start + WATCHLIST_PAGE_SIZE).flatMap((item) => {
    const id = getMangaWatchlistId(item);
    return id === undefined ? [] : [id];
  });
};

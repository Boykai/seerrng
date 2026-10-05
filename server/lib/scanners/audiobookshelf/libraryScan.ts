import type { AudiobookshelfLibraryItem } from '@server/api/audiobookshelf';
import { MAX_SERVARR_LIBRARY_RESULTS } from '@server/api/servarr/base';

export const AUDIOBOOKSHELF_PAGE_SIZE = 100;
export const AUDIOBOOKSHELF_MAX_LIBRARY_ITEMS = MAX_SERVARR_LIBRARY_RESULTS;
export const AUDIOBOOKSHELF_MAX_LIBRARY_PAGES = Math.ceil(
  AUDIOBOOKSHELF_MAX_LIBRARY_ITEMS / AUDIOBOOKSHELF_PAGE_SIZE
);
const MAX_ITEM_ID_LENGTH = 256;

export const getCompleteAudiobookshelfItemIds = (
  items: readonly AudiobookshelfLibraryItem[],
  expectedTotal: number
): Set<string> | undefined => {
  if (
    !Number.isSafeInteger(expectedTotal) ||
    expectedTotal < 0 ||
    expectedTotal > AUDIOBOOKSHELF_MAX_LIBRARY_ITEMS ||
    items.length !== expectedTotal
  ) {
    return undefined;
  }

  const ids = new Set<string>();

  for (const item of items) {
    const itemId =
      item && typeof item.id === 'string' ? item.id.trim() : undefined;
    if (!itemId || itemId.length > MAX_ITEM_ID_LENGTH || ids.has(itemId)) {
      return undefined;
    }
    ids.add(itemId);
  }

  return ids;
};

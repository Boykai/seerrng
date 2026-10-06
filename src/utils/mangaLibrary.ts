import { buildDiscoverQueryString } from '@server/utils/discoverQuery';

/** The manga library as catalog cards, in the discover response shape. */
export const MANGA_LIBRARY_URL = '/api/v1/discover/manga/library';

/** The full manga library list on the Manga page. */
export const MANGA_LIBRARY_PAGE_PATH = '/discover/manga/library';

/** One page of the manga library, as My Library reads it. */
export const mangaLibraryPageUrl = (page: number): string =>
  `${MANGA_LIBRARY_URL}?${buildDiscoverQueryString({ page })}`;

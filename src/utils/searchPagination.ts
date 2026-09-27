export const MAX_SEARCH_PAGES = 500;

/** A sparse filtered page is not the end of the provider catalogue. */
export const hasMoreSearchPages = (
  totalPages: number | undefined,
  loadedPages: number
): boolean =>
  typeof totalPages === 'number' &&
  Math.min(totalPages, MAX_SEARCH_PAGES) > loadedPages;

// Shared search and slider responses can include manga before the client has
// manga cards, so those views drop these results instead of rendering them.
export const isMangaResult = (result: { mediaType?: string }): boolean =>
  result.mediaType === 'manga';

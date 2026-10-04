import {
  encodeApiPathSegment,
  normalizeMusicBrainzId,
} from '@app/utils/apiPath';
import type { ReleaseCalendarItem } from '@server/lib/releaseCalendar/normalize';

/** The details page a release calendar entry links to, if it has one. */
export const releaseCalendarHref = (
  item: ReleaseCalendarItem
): string | undefined => {
  if (item.mediaType === 'software' && item.softwareCategory && item.igdbId)
    return `/software?category=${item.softwareCategory}&game=${item.igdbId}`;
  if (item.mediaType === 'music' && item.mbId)
    return `/music/${encodeApiPathSegment(normalizeMusicBrainzId(item.mbId))}`;
  if (item.mediaType === 'book' && item.bookId)
    return `/book/${encodeApiPathSegment(item.bookId)}?format=${item.bookFormat ?? 'ebook'}&lookupTitle=${encodeURIComponent(item.title)}`;
  if (item.mediaType === 'comic' && item.comicId)
    return '/comic/' + encodeApiPathSegment(item.comicId);
  if (item.mediaType === 'magazine' && item.magazineTitle)
    return '/magazine/' + encodeApiPathSegment(item.magazineTitle);
  if (item.mediaType === 'manga' && item.mangaId)
    return `/manga/${encodeApiPathSegment(item.mangaId)}`;
  if (item.tmdbId) return `/${item.mediaType}/${item.tmdbId}`;
  return undefined;
};

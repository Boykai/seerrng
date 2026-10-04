import {
  isValidMusicBrainzResourceId,
  normalizeMusicBrainzId,
} from '@server/lib/externalIds';
import { normalizeValidIsbn } from '@server/lib/isbn';
import { makeBookshelfBookId } from '@server/utils/bookshelfCatalog';

export type ReleaseCalendarBookFormat = 'ebook' | 'audiobook';

export interface ReleaseCalendarItem {
  id: string;
  source:
    | 'radarr'
    | 'sonarr'
    | 'lidarr'
    | 'readarr'
    | 'mylar'
    | 'kapowarr'
    | 'lazylibrarian'
    | 'questarr'
    | 'romarr'
    | 'suwayomi';
  mediaType:
    | 'movie'
    | 'tv'
    | 'music'
    | 'book'
    | 'comic'
    | 'magazine'
    | 'software'
    | 'manga';
  title: string;
  startsAt: string;
  dateType:
    | 'digital'
    | 'physical'
    | 'theatrical'
    | 'air'
    | 'album'
    | 'book'
    | 'issue'
    | 'game'
    | 'chapter';
  allDay: boolean;
  tmdbId?: number;
  tvdbId?: number;
  mbId?: string;
  artistName?: string;
  bookId?: string;
  foreignBookId?: string;
  foreignEditionId?: string;
  isbnCandidates?: string[];
  bookFormat?: ReleaseCalendarBookFormat;
  authorName?: string;
  softwareCategory?: 'game' | 'retro' | 'modern';
  igdbId?: number;
  platformName?: string;
  comicId?: string;
  magazineTitle?: string;
  issueNumber?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  /** The AniList ID of a manga entry. */
  mangaId?: number;
  /** Chapters a manga entry stands for. */
  chapterCount?: number;
  available: boolean;
  is4k: boolean;
  dateChanges?: ReleaseCalendarDateChange[];
}
export interface ReleaseCalendarDateChange {
  previousStartsAt: string;
  startsAt: string;
  changedAt: string;
  previousAllDay: boolean;
  allDay: boolean;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 1000)
    : undefined;
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))
    return undefined;
  const datePart = value.slice(0, 10);
  const calendarDate = new Date(`${datePart}T00:00:00.000Z`);
  if (
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== datePart
  )
    return undefined;
  const parsed = new Date(
    value.length === 10 ? `${value}T00:00:00.000Z` : value
  );
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}
export function normalizeCalendarRow(
  source: 'radarr' | 'sonarr' | 'lidarr' | 'readarr',
  serverId: number,
  is4k: boolean,
  value: unknown,
  start?: Date,
  end?: Date,
  bookFormat: ReleaseCalendarBookFormat = 'ebook'
): ReleaseCalendarItem | undefined {
  const row = record(value);
  if (!row) return undefined;
  const id = positive(row.id);
  if (!id) return undefined;
  if (source === 'readarr') {
    const title = text(row.title);
    const releaseDate =
      typeof row.releaseDate === 'string' ? row.releaseDate.slice(0, 10) : '';
    const startsAt = timestamp(releaseDate);
    const foreignBookId = text(row.foreignBookId);
    const foreignEditionId = text(row.foreignEditionId);
    const editions = Array.isArray(row.editions) ? row.editions : [];
    const isbnCandidates = [
      ...new Set(
        editions.slice(0, 100).flatMap((value) => {
          const edition = record(value);
          return [
            normalizeValidIsbn(text(edition?.isbn13)),
            normalizeValidIsbn(text(edition?.isbn10)),
          ].filter((isbn): isbn is string => !!isbn);
        })
      ),
    ].slice(0, 24);
    const author = record(row.author);
    const authorName = text(author?.authorName ?? row.authorName);
    const statistics = record(row.statistics);
    const bookFileCount = positive(statistics?.bookFileCount);
    if (!title || !startsAt) return undefined;
    return {
      id: `readarr:${serverId}:${id}`,
      source,
      mediaType: 'book',
      title,
      startsAt,
      dateType: 'book',
      allDay: true,
      ...(foreignBookId
        ? {
            foreignBookId,
            bookId: makeBookshelfBookId(serverId, foreignBookId),
          }
        : {}),
      ...(foreignEditionId ? { foreignEditionId } : {}),
      ...(isbnCandidates.length ? { isbnCandidates } : {}),
      ...(authorName ? { authorName } : {}),
      bookFormat,
      available: row.hasFile === true || bookFileCount !== undefined,
      is4k: false,
    };
  }
  if (source === 'lidarr') {
    const title = text(row.title);
    const releaseDate =
      typeof row.releaseDate === 'string' ? row.releaseDate.slice(0, 10) : '';
    const startsAt = timestamp(releaseDate);
    const rawMbId = text(row.foreignAlbumId);
    const normalizedMbId = rawMbId
      ? normalizeMusicBrainzId(rawMbId)
      : undefined;
    const mbId =
      normalizedMbId && isValidMusicBrainzResourceId(normalizedMbId)
        ? normalizedMbId
        : undefined;
    const artist = record(row.artist);
    const artistName = text(artist?.artistName ?? row.artistName);
    const statistics = record(row.statistics);
    const totalTrackCount = positive(statistics?.totalTrackCount);
    const trackFileCount = positive(statistics?.trackFileCount);
    if (!title || !startsAt) return undefined;
    return {
      id: `lidarr:${serverId}:${id}`,
      source,
      mediaType: 'music',
      title,
      startsAt,
      dateType: 'album',
      allDay: true,
      ...(mbId ? { mbId } : {}),
      ...(artistName ? { artistName } : {}),
      available:
        row.hasFile === true ||
        (!!totalTrackCount &&
          trackFileCount !== undefined &&
          trackFileCount >= totalTrackCount),
      is4k: false,
    };
  }
  if (source === 'radarr') {
    const title = text(row.title);
    if (!title) return undefined;
    for (const [field, dateType] of [
      ['digitalRelease', 'digital'],
      ['physicalRelease', 'physical'],
      ['inCinemas', 'theatrical'],
    ] as const) {
      const startsAt = timestamp(row[field]);
      if (
        !startsAt ||
        (start && new Date(startsAt) < start) ||
        (end && new Date(startsAt) >= end)
      )
        continue;
      return {
        id: `radarr:${serverId}:${id}`,
        source,
        mediaType: 'movie',
        title,
        startsAt,
        dateType,
        allDay: true,
        tmdbId: positive(row.tmdbId),
        available: row.hasFile === true,
        is4k,
      };
    }
    return undefined;
  }
  const series = record(row.series);
  const title = text(series?.title);
  const startsAt = timestamp(row.airDateUtc ?? row.airDate);
  const seasonNumber =
    typeof row.seasonNumber === 'number' &&
    Number.isSafeInteger(row.seasonNumber) &&
    row.seasonNumber >= 0
      ? row.seasonNumber
      : undefined;
  const episodeNumber = positive(row.episodeNumber);
  if (!title || !startsAt || seasonNumber === undefined || !episodeNumber)
    return undefined;
  return {
    id: `sonarr:${serverId}:${id}`,
    source,
    mediaType: 'tv',
    title,
    startsAt,
    dateType: 'air',
    allDay: !row.airDateUtc,
    tmdbId: positive(series?.tmdbId),
    tvdbId: positive(series?.tvdbId),
    seasonNumber,
    episodeNumber,
    episodeTitle: text(row.title),
    available: row.hasFile === true,
    is4k,
  };
}

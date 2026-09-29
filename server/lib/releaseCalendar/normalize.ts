export interface ReleaseCalendarItem {
  id: string;
  source: 'radarr' | 'sonarr';
  mediaType: 'movie' | 'tv';
  title: string;
  startsAt: string;
  dateType: 'digital' | 'physical' | 'theatrical' | 'air';
  allDay: boolean;
  tmdbId?: number;
  tvdbId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
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
  source: 'radarr' | 'sonarr',
  serverId: number,
  is4k: boolean,
  value: unknown,
  start?: Date,
  end?: Date
): ReleaseCalendarItem | undefined {
  const row = record(value);
  if (!row) return undefined;
  const id = positive(row.id);
  if (!id) return undefined;
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

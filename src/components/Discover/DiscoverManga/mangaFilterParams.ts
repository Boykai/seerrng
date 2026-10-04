import type {
  AnilistMangaCountry,
  AnilistMangaFormat,
  AnilistMangaSource,
  AnilistMangaStatus,
} from '@server/api/anilist/manga';
import type { ParsedUrlQuery } from 'querystring';

export const MANGA_FORMATS = [
  'MANGA',
  'ONE_SHOT',
  'NOVEL',
] as const satisfies readonly AnilistMangaFormat[];
export const MANGA_STATUSES = [
  'FINISHED',
  'RELEASING',
  'NOT_YET_RELEASED',
  'CANCELLED',
  'HIATUS',
] as const satisfies readonly AnilistMangaStatus[];
export const MANGA_COUNTRIES = [
  'JP',
  'KR',
  'CN',
  'TW',
] as const satisfies readonly AnilistMangaCountry[];
export const MANGA_SOURCES = [
  'ORIGINAL',
  'MANGA',
  'LIGHT_NOVEL',
  'WEB_NOVEL',
  'NOVEL',
  'VISUAL_NOVEL',
  'VIDEO_GAME',
  'GAME',
  'ANIME',
  'LIVE_ACTION',
  'COMIC',
  'DOUJINSHI',
  'PICTURE_BOOK',
  'MULTIMEDIA_PROJECT',
  'OTHER',
] as const satisfies readonly AnilistMangaSource[];

export const MANGA_NAME_FILTERS = [
  'genres',
  'excludeGenres',
  'tags',
  'excludeTags',
] as const;
export const MANGA_FILTER_KEYS = [
  'format',
  'status',
  'countryOfOrigin',
  'source',
  ...MANGA_NAME_FILTERS,
  'minStartYear',
  'maxStartYear',
  'minScore',
  'maxScore',
  'minChapters',
  'maxChapters',
  'minVolumes',
  'maxVolumes',
] as const;
// The API accepts at most this many names in each list.
export const MAX_MANGA_FILTER_NAMES = 10;

export type MangaNameFilter = (typeof MANGA_NAME_FILTERS)[number];
export type MangaFilterKey = (typeof MANGA_FILTER_KEYS)[number];
export type MangaFilterParams = Partial<Record<MangaFilterKey, string>>;
export type MangaFilterUpdate = Partial<
  Record<MangaFilterKey, string | undefined>
>;

export const clearedMangaFilters: MangaFilterUpdate = Object.fromEntries(
  MANGA_FILTER_KEYS.map((key) => [key, undefined])
);

export const splitMangaFilterNames = (value?: string): string[] => [
  ...new Set(
    (value ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  ),
];

export const joinMangaFilterNames = (
  names: readonly string[]
): string | undefined => (names.length ? names.join(',') : undefined);

const allowedValues: Partial<Record<MangaFilterKey, readonly string[]>> = {
  format: MANGA_FORMATS,
  status: MANGA_STATUSES,
  countryOfOrigin: MANGA_COUNTRIES,
  source: MANGA_SOURCES,
};
const nameFilters: ReadonlySet<string> = new Set(MANGA_NAME_FILTERS);

// Reads the filters from the page address. A value the controls cannot show
// is left out, so the request matches what the page displays.
export const getMangaFilterParams = (
  query: ParsedUrlQuery
): MangaFilterParams => {
  const params: MangaFilterParams = {};
  for (const key of MANGA_FILTER_KEYS) {
    const raw = query[key];
    if (typeof raw !== 'string') continue;
    const allowed = allowedValues[key];
    const value = nameFilters.has(key)
      ? joinMangaFilterNames(splitMangaFilterNames(raw))
      : allowed
        ? allowed.find((candidate) => candidate === raw)
        : /^\d{1,6}$/.test(raw)
          ? raw
          : undefined;
    if (value) params[key] = value;
  }
  return params;
};

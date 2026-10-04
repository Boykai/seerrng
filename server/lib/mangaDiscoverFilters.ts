import type {
  AnilistMangaDiscoverFilters,
  AnilistMangaRange,
} from '@server/api/anilist/manga';
import {
  ANILIST_MANGA_SOURCES,
  MAX_ANILIST_FILTER_NAME_LENGTH,
} from '@server/api/anilist/manga';
import { parseOptionalAllowedString } from '@server/utils/validation';

export const MAX_MANGA_FILTER_NAMES = 10;
// Ten names of the longest allowed length and the commas between them.
export const MAX_MANGA_FILTER_LIST_LENGTH =
  MAX_MANGA_FILTER_NAMES * (MAX_ANILIST_FILTER_NAME_LENGTH + 1) - 1;

const NAME_LISTS = [
  ['genres', 'genres'],
  ['excludedGenres', 'excludeGenres'],
  ['tags', 'tags'],
  ['excludedTags', 'excludeTags'],
] as const;

interface RangeBounds {
  minKey: string;
  maxKey: string;
  lower: number;
  upper: number;
}

const RANGES: Record<
  'startYear' | 'averageScore' | 'chapters' | 'volumes',
  RangeBounds
> = {
  startYear: {
    minKey: 'minStartYear',
    maxKey: 'maxStartYear',
    lower: 1800,
    upper: 2200,
  },
  averageScore: {
    minKey: 'minScore',
    maxKey: 'maxScore',
    lower: 0,
    upper: 100,
  },
  chapters: {
    minKey: 'minChapters',
    maxKey: 'maxChapters',
    lower: 0,
    upper: 100_000,
  },
  volumes: {
    minKey: 'minVolumes',
    maxKey: 'maxVolumes',
    lower: 0,
    upper: 100_000,
  },
};

type Parsed<T> = { value: T } | { error: string };

// 1-10 comma-separated names of 1-64 characters, trimmed; duplicates collapse.
const parseNameList = (
  value: unknown,
  fieldName: string
): Parsed<string[] | undefined> => {
  if (value === undefined || value === null || value === '') {
    return { value: undefined };
  }
  const invalid = {
    error: `${fieldName} must list 1 to ${MAX_MANGA_FILTER_NAMES} names of up to ${MAX_ANILIST_FILTER_NAME_LENGTH} characters, separated by commas.`,
  };
  if (
    typeof value !== 'string' ||
    value.length > MAX_MANGA_FILTER_LIST_LENGTH
  ) {
    return invalid;
  }
  const parts = value.split(',');
  if (parts.length > MAX_MANGA_FILTER_NAMES) {
    return invalid;
  }
  const names = new Set<string>();
  for (const part of parts) {
    const name = part.trim();
    if (!name || name.length > MAX_ANILIST_FILTER_NAME_LENGTH) {
      return invalid;
    }
    names.add(name);
  }
  return { value: [...names] };
};

// The OpenAPI validator passes integers on as numbers; other callers send
// query strings.
const parseBoundedInteger = (
  value: unknown,
  fieldName: string,
  lower: number,
  upper: number
): Parsed<number | undefined> => {
  if (value === undefined || value === null || value === '') {
    return { value: undefined };
  }
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d{1,15}$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(number) && number >= lower && number <= upper
    ? { value: number }
    : {
        error: `${fieldName} must be a whole number from ${lower} to ${upper}.`,
      };
};

const parseRange = (
  query: Record<string, unknown>,
  { minKey, maxKey, lower, upper }: RangeBounds
): Parsed<AnilistMangaRange | undefined> => {
  const min = parseBoundedInteger(query[minKey], minKey, lower, upper);
  if ('error' in min) {
    return min;
  }
  const max = parseBoundedInteger(query[maxKey], maxKey, lower, upper);
  if ('error' in max) {
    return max;
  }
  if (min.value === undefined && max.value === undefined) {
    return { value: undefined };
  }
  if (
    min.value !== undefined &&
    max.value !== undefined &&
    min.value > max.value
  ) {
    return { error: `${minKey} must not be greater than ${maxKey}.` };
  }
  return {
    value: {
      ...(min.value !== undefined ? { min: min.value } : {}),
      ...(max.value !== undefined ? { max: max.value } : {}),
    },
  };
};

/**
 * The AniList filters of a discover request, with only the filters that were
 * set. `genre` is the single-genre parameter, which must not also be
 * excluded.
 */
export const parseMangaDiscoverFilters = (
  query: Record<string, unknown>,
  genre: string | undefined
): Parsed<AnilistMangaDiscoverFilters> => {
  const filters: AnilistMangaDiscoverFilters = {};
  for (const [key, fieldName] of NAME_LISTS) {
    const parsed = parseNameList(query[fieldName], fieldName);
    if ('error' in parsed) {
      return parsed;
    }
    if (parsed.value) {
      filters[key] = parsed.value;
    }
  }

  const source = parseOptionalAllowedString(query.source, {
    fieldName: 'source',
    allowedValues: ANILIST_MANGA_SOURCES,
    maxLength: 32,
  });
  if ('error' in source) {
    return source;
  }
  if (source.value) {
    filters.source = source.value;
  }

  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const parsed = parseRange(query, RANGES[key]);
    if ('error' in parsed) {
      return parsed;
    }
    if (parsed.value) {
      filters[key] = parsed.value;
    }
  }

  const includedGenres = new Set([
    ...(filters.genres ?? []),
    ...(genre ? [genre] : []),
  ]);
  if (filters.excludedGenres?.some((name) => includedGenres.has(name))) {
    return { error: 'genres and excludeGenres must not share a name.' };
  }
  const includedTags = new Set(filters.tags);
  if (filters.excludedTags?.some((name) => includedTags.has(name))) {
    return { error: 'tags and excludeTags must not share a name.' };
  }
  return { value: filters };
};

import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

export const ANILIST_MANGA_DETAILS_TTL_SECONDS = 43_200;
export const ANILIST_MANGA_PAGE_TTL_SECONDS = 3_600;

export const ANILIST_MANGA_FORMATS = ['MANGA', 'ONE_SHOT', 'NOVEL'] as const;
export const ANILIST_MANGA_STATUSES = [
  'FINISHED',
  'RELEASING',
  'NOT_YET_RELEASED',
  'CANCELLED',
  'HIATUS',
] as const;
export const ANILIST_MANGA_COUNTRIES = ['JP', 'KR', 'CN', 'TW'] as const;

export type AnilistMangaFormat = (typeof ANILIST_MANGA_FORMATS)[number];
export type AnilistMangaStatus = (typeof ANILIST_MANGA_STATUSES)[number];
export type AnilistMangaCountry = (typeof ANILIST_MANGA_COUNTRIES)[number];
export type AnilistMangaSort =
  | 'TRENDING_DESC'
  | 'POPULARITY_DESC'
  | 'SCORE_DESC'
  | 'SEARCH_MATCH'
  | 'POPULARITY'
  | 'SCORE'
  | 'START_DATE'
  | 'START_DATE_DESC'
  | 'TITLE_ROMAJI'
  | 'TITLE_ROMAJI_DESC'
  | 'ID'
  | 'ID_DESC';

// Every AniList MediaSource value; discovery can filter by any of them.
export const ANILIST_MANGA_SOURCES = [
  'ORIGINAL',
  'MANGA',
  'LIGHT_NOVEL',
  'VISUAL_NOVEL',
  'VIDEO_GAME',
  'OTHER',
  'NOVEL',
  'DOUJINSHI',
  'ANIME',
  'WEB_NOVEL',
  'LIVE_ACTION',
  'GAME',
  'COMIC',
  'MULTIMEDIA_PROJECT',
  'PICTURE_BOOK',
] as const;
export type AnilistMangaSource = (typeof ANILIST_MANGA_SOURCES)[number];

export const ANILIST_MANGA_FILTER_OPTIONS_TTL_SECONDS = 86_400;
export const MAX_ANILIST_FILTER_NAME_LENGTH = 64;
const MAX_ANILIST_FILTER_GENRES = 100;
const MAX_ANILIST_FILTER_TAGS = 1_000;
// AniList's genre for adult titles; its tags carry their own adult flag.
const ANILIST_ADULT_GENRES: ReadonlySet<string> = new Set(['Hentai']);

const MAX_TEXT_LENGTH = 512;
const MAX_LABEL_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_URL_LENGTH = 2048;
const MAX_LIST_ITEMS = 50;
const MAX_STAFF_ITEMS = 25;

// AniList serves artwork from one CDN host and its pages from one site host.
const ANILIST_IMAGE_HOSTS = new Set(['s4.anilist.co']);
const ANILIST_SITE_HOSTS = new Set(['anilist.co']);

const MANGA_SUMMARY_FIELDS = `
  id
  idMal
  title { romaji english native }
  synonyms
  format
  status
  chapters
  volumes
  isAdult
  coverImage { extraLarge large }
  bannerImage
  genres
  startDate { year month day }
  countryOfOrigin
  averageScore
`;

export const MANGA_DETAILS_QUERY = `
  query MangaDetails($id: Int) {
    Media(id: $id, type: MANGA) {
      ${MANGA_SUMMARY_FIELDS}
      endDate { year month day }
      description(asHtml: true)
      siteUrl
      tags { name rank isMediaSpoiler isGeneralSpoiler isAdult }
      staff(perPage: ${MAX_STAFF_ITEMS}) {
        edges { role node { id name { full } } }
      }
    }
  }
`;

export const MANGA_PAGE_QUERY = `
  query MangaPage(
    $page: Int
    $perPage: Int
    $sort: [MediaSort]
    $search: String
    $genre: String
    $formatIn: [MediaFormat]
    $formatNotIn: [MediaFormat]
    $status: MediaStatus
    $countryOfOrigin: CountryCode
    $isAdult: Boolean
    $genreIn: [String]
    $genreNotIn: [String]
    $tagIn: [String]
    $tagNotIn: [String]
    $source: MediaSource
    $startDateGreater: FuzzyDateInt
    $startDateLesser: FuzzyDateInt
    $averageScoreGreater: Int
    $averageScoreLesser: Int
    $chaptersGreater: Int
    $chaptersLesser: Int
    $volumesGreater: Int
    $volumesLesser: Int
  ) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage }
      media(
        type: MANGA
        sort: $sort
        search: $search
        genre: $genre
        format_in: $formatIn
        format_not_in: $formatNotIn
        status: $status
        countryOfOrigin: $countryOfOrigin
        isAdult: $isAdult
        genre_in: $genreIn
        genre_not_in: $genreNotIn
        tag_in: $tagIn
        tag_not_in: $tagNotIn
        source: $source
        startDate_greater: $startDateGreater
        startDate_lesser: $startDateLesser
        averageScore_greater: $averageScoreGreater
        averageScore_lesser: $averageScoreLesser
        chapters_greater: $chaptersGreater
        chapters_lesser: $chaptersLesser
        volumes_greater: $volumesGreater
        volumes_lesser: $volumesLesser
      ) {
        ${MANGA_SUMMARY_FIELDS}
      }
    }
  }
`;

export const ANILIST_MAL_LOOKUP_PAGE_SIZE = 50;

// Exact links for library matching. One MyAnimeList ID can belong to more
// than one AniList entry, so a batch can span several pages.
export const MANGA_IDS_BY_MAL_QUERY = `
  query MangaIdsByMal($page: Int, $malIds: [Int]) {
    Page(page: $page, perPage: ${ANILIST_MAL_LOOKUP_PAGE_SIZE}) {
      pageInfo { hasNextPage }
      media(idMal_in: $malIds, type: MANGA, sort: [ID]) { id idMal }
    }
  }
`;

export const ANILIST_MANGA_BATCH_SIZE = 50;

// Catalog cards for known IDs, read in one request. Exclusions are applied by
// the caller, so one cached reply serves every content policy.
export const MANGA_BY_IDS_QUERY = `
  query MangaByIds($ids: [Int]) {
    Page(perPage: ${ANILIST_MANGA_BATCH_SIZE}) {
      media(id_in: $ids, type: MANGA, sort: [ID]) {
        ${MANGA_SUMMARY_FIELDS}
      }
    }
  }
`;

// Genre and tag names only: no IDs or descriptions are requested. One cached
// reply serves every content policy; the caller applies it.
export const MANGA_FILTER_OPTIONS_QUERY = `
  query MangaFilterOptions {
    GenreCollection
    MediaTagCollection { name isAdult }
  }
`;

export interface AnilistMangaContentPolicy {
  includeAdult: boolean;
  includeNovels: boolean;
}

/** Inclusive bounds; either end may be open. */
export interface AnilistMangaRange {
  min?: number;
  max?: number;
}

export interface AnilistMangaDiscoverFilters {
  genres?: string[];
  excludedGenres?: string[];
  tags?: string[];
  excludedTags?: string[];
  source?: AnilistMangaSource;
  startYear?: AnilistMangaRange;
  averageScore?: AnilistMangaRange;
  chapters?: AnilistMangaRange;
  volumes?: AnilistMangaRange;
}

export interface AnilistMangaFilterOption {
  name: string;
  isAdult: boolean;
}

export interface AnilistMangaFilterOptions {
  genres: AnilistMangaFilterOption[];
  tags: AnilistMangaFilterOption[];
}

export interface AnilistMangaPageOptions
  extends AnilistMangaContentPolicy, AnilistMangaDiscoverFilters {
  page: number;
  sort: AnilistMangaSort[];
  search?: string;
  genre?: string;
  format?: AnilistMangaFormat;
  status?: AnilistMangaStatus;
  countryOfOrigin?: AnilistMangaCountry;
}

export interface AnilistMangaTitles {
  romaji?: string;
  english?: string;
  native?: string;
}

export interface AnilistMangaTag {
  name: string;
  rank?: number;
  isSpoiler: boolean;
  isAdult: boolean;
}

export interface AnilistMangaStaffCredit {
  id: number;
  name: string;
  role: string;
}

export interface AnilistMangaSummary {
  id: number;
  idMal?: number;
  titles: AnilistMangaTitles;
  synonyms: string[];
  format?: AnilistMangaFormat;
  status?: AnilistMangaStatus;
  chapters?: number;
  volumes?: number;
  isAdult: boolean;
  coverImage?: string;
  bannerImage?: string;
  genres: string[];
  startYear?: number;
  countryOfOrigin?: string;
  averageScore?: number;
}

export interface AnilistMangaDetails extends AnilistMangaSummary {
  description?: string;
  tags: AnilistMangaTag[];
  staff: AnilistMangaStaffCredit[];
  siteUrl?: string;
  startDate?: string;
  endDate?: string;
}

export interface AnilistMangaPage {
  pageInfo: {
    total?: number;
    currentPage?: number;
    lastPage?: number;
    hasNextPage: boolean;
  };
  media: AnilistMangaSummary[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const boundedString = (
  value: unknown,
  maxLength = MAX_TEXT_LENGTH
): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
};

const boundedStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const items = new Set<string>();
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    const text = boundedString(item);
    if (text) {
      items.add(text);
    }
  }
  return [...items];
};

const boundedInteger = (
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): number | undefined =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max
    ? value
    : undefined;

const sanitizeUrl = (
  value: unknown,
  allowedHosts: ReadonlySet<string>
): string | undefined => {
  const candidate = boundedString(value, MAX_URL_LENGTH);
  if (!candidate) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' &&
      url.port === '' &&
      !url.username &&
      !url.password &&
      allowedHosts.has(url.hostname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const oneOf = <T extends string>(
  allowed: readonly T[],
  value: unknown
): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

export const normalizeAnilistMangaFormat = (
  value: unknown
): AnilistMangaFormat | undefined => oneOf(ANILIST_MANGA_FORMATS, value);

export const normalizeAnilistMangaStatus = (
  value: unknown
): AnilistMangaStatus | undefined => oneOf(ANILIST_MANGA_STATUSES, value);

const sanitizeCountry = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : undefined;

// AniList dates may be partial: year, year and month, or a full date.
const formatFuzzyDate = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const year = boundedInteger(value.year, 1, 9999);
  if (year === undefined) {
    return undefined;
  }
  const yearText = String(year).padStart(4, '0');
  const month = boundedInteger(value.month, 1, 12);
  if (month === undefined) {
    return yearText;
  }
  const monthText = `${yearText}-${String(month).padStart(2, '0')}`;
  const day = boundedInteger(value.day, 1, 31);
  return day === undefined
    ? monthText
    : `${monthText}-${String(day).padStart(2, '0')}`;
};

const descriptionWindow = new JSDOM('').window;
const descriptionPurify = DOMPurify(descriptionWindow);

export const sanitizeAnilistDescription = (
  value: unknown
): string | undefined => {
  const html = boundedString(value, MAX_DESCRIPTION_LENGTH);
  if (!html) {
    return undefined;
  }
  // Remove spoilers with their text first: DOMPurify keeps the text of a
  // disallowed wrapper element, which would reveal the spoiler.
  const template = descriptionWindow.document.createElement('template');
  template.innerHTML = html;
  template.content
    .querySelectorAll('.markdown_spoiler')
    .forEach((node) => node.remove());
  const sanitized = descriptionPurify
    .sanitize(template.innerHTML, {
      ALLOWED_TAGS: ['b', 'br', 'em', 'i', 'p', 'strong'],
      ALLOWED_ATTR: [],
      ALLOW_DATA_ATTR: false,
    })
    .trim();
  return sanitized || undefined;
};

const sanitizeTags = (value: unknown): AnilistMangaTag[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_LIST_ITEMS).flatMap((item) => {
    const name = isRecord(item)
      ? boundedString(item.name, MAX_LABEL_LENGTH)
      : undefined;
    if (!isRecord(item) || !name) {
      return [];
    }
    return [
      {
        name,
        rank: boundedInteger(item.rank, 0, 100),
        isSpoiler:
          item.isMediaSpoiler === true || item.isGeneralSpoiler === true,
        isAdult: item.isAdult === true,
      },
    ];
  });
};

const sanitizeStaff = (value: unknown): AnilistMangaStaffCredit[] => {
  const edges =
    isRecord(value) && Array.isArray(value.edges) ? value.edges : [];
  return edges.slice(0, MAX_STAFF_ITEMS).flatMap((edge) => {
    if (!isRecord(edge) || !isRecord(edge.node)) {
      return [];
    }
    const id = boundedInteger(edge.node.id, 1);
    const name = isRecord(edge.node.name)
      ? boundedString(edge.node.name.full)
      : undefined;
    const role = boundedString(edge.role, MAX_LABEL_LENGTH);
    return id !== undefined && name && role ? [{ id, name, role }] : [];
  });
};

export const sanitizeAnilistMangaSummary = (
  value: unknown
): AnilistMangaSummary | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = boundedInteger(value.id, 1);
  const title = isRecord(value.title) ? value.title : {};
  const titles: AnilistMangaTitles = {
    romaji: boundedString(title.romaji),
    english: boundedString(title.english),
    native: boundedString(title.native),
  };
  if (
    id === undefined ||
    (!titles.romaji && !titles.english && !titles.native)
  ) {
    return undefined;
  }
  const cover = isRecord(value.coverImage) ? value.coverImage : {};
  return {
    id,
    idMal: boundedInteger(value.idMal, 1),
    titles,
    synonyms: boundedStringList(value.synonyms),
    format: normalizeAnilistMangaFormat(value.format),
    status: normalizeAnilistMangaStatus(value.status),
    chapters: boundedInteger(value.chapters),
    volumes: boundedInteger(value.volumes),
    isAdult: value.isAdult === true,
    coverImage:
      sanitizeUrl(cover.extraLarge, ANILIST_IMAGE_HOSTS) ??
      sanitizeUrl(cover.large, ANILIST_IMAGE_HOSTS),
    bannerImage: sanitizeUrl(value.bannerImage, ANILIST_IMAGE_HOSTS),
    genres: boundedStringList(value.genres),
    startYear: isRecord(value.startDate)
      ? boundedInteger(value.startDate.year, 1, 9999)
      : undefined,
    countryOfOrigin: sanitizeCountry(value.countryOfOrigin),
    averageScore: boundedInteger(value.averageScore, 0, 100),
  };
};

export const sanitizeAnilistMangaDetails = (
  value: unknown
): AnilistMangaDetails | undefined => {
  const summary = sanitizeAnilistMangaSummary(value);
  if (!summary || !isRecord(value)) {
    return undefined;
  }
  return {
    ...summary,
    description: sanitizeAnilistDescription(value.description),
    tags: sanitizeTags(value.tags),
    staff: sanitizeStaff(value.staff),
    siteUrl: sanitizeUrl(value.siteUrl, ANILIST_SITE_HOSTS),
    startDate: formatFuzzyDate(value.startDate),
    endDate: formatFuzzyDate(value.endDate),
  };
};

export const isAnilistMangaExcluded = (
  manga: Pick<AnilistMangaSummary, 'isAdult' | 'format'>,
  policy: AnilistMangaContentPolicy
): boolean =>
  (!policy.includeAdult && manga.isAdult) ||
  (!policy.includeNovels && manga.format === 'NOVEL');

// AniList's _greater and _lesser comparisons are exclusive and skip titles
// without a value, so inclusive bounds widen by one and a bound that would
// exclude no known value is left out.
const setCountRange = (
  variables: Record<string, unknown>,
  name: string,
  range: AnilistMangaRange | undefined,
  ceiling = Number.POSITIVE_INFINITY
): void => {
  if (range?.min !== undefined && range.min > 0) {
    variables[`${name}Greater`] = range.min - 1;
  }
  if (range?.max !== undefined && range.max < ceiling) {
    variables[`${name}Lesser`] = range.max + 1;
  }
};

const setDiscoverFilterVariables = (
  variables: Record<string, unknown>,
  filters: AnilistMangaDiscoverFilters
): void => {
  if (filters.genres?.length) variables.genreIn = filters.genres;
  if (filters.excludedGenres?.length) {
    variables.genreNotIn = filters.excludedGenres;
  }
  if (filters.tags?.length) variables.tagIn = filters.tags;
  if (filters.excludedTags?.length) variables.tagNotIn = filters.excludedTags;
  if (filters.source) variables.source = filters.source;
  // Fuzzy dates are YYYYMMDD integers. YYYY9999 is never a real date, so the
  // year bounds hold whether AniList compares inclusively or not.
  if (filters.startYear?.min !== undefined) {
    variables.startDateGreater = filters.startYear.min * 10_000 - 1;
  }
  if (filters.startYear?.max !== undefined) {
    variables.startDateLesser = (filters.startYear.max + 1) * 10_000 - 1;
  }
  setCountRange(variables, 'averageScore', filters.averageScore, 100);
  setCountRange(variables, 'chapters', filters.chapters);
  setCountRange(variables, 'volumes', filters.volumes);
};

// Unset filters are left out entirely so AniList applies no filter for them.
export const buildAnilistMangaPageVariables = (
  options: AnilistMangaPageOptions,
  perPage: number
): Record<string, unknown> => {
  const variables: Record<string, unknown> = {
    page: options.page,
    perPage,
    sort: options.sort,
  };
  if (options.search) variables.search = options.search;
  if (options.genre) variables.genre = options.genre;
  if (options.format) variables.formatIn = [options.format];
  if (!options.includeNovels) variables.formatNotIn = ['NOVEL'];
  if (options.status) variables.status = options.status;
  if (options.countryOfOrigin) {
    variables.countryOfOrigin = options.countryOfOrigin;
  }
  if (!options.includeAdult) variables.isAdult = false;
  setDiscoverFilterVariables(variables, options);
  return variables;
};

export const sanitizeAnilistMangaPage = (
  value: unknown,
  policy: AnilistMangaContentPolicy
): AnilistMangaPage => {
  const page = isRecord(value) ? value : {};
  const pageInfo = isRecord(page.pageInfo) ? page.pageInfo : {};
  const media = Array.isArray(page.media)
    ? page.media.slice(0, MAX_LIST_ITEMS)
    : [];
  return {
    pageInfo: {
      total: boundedInteger(pageInfo.total),
      currentPage: boundedInteger(pageInfo.currentPage, 1),
      lastPage: boundedInteger(pageInfo.lastPage, 1),
      hasNextPage: pageInfo.hasNextPage === true,
    },
    // AniList applies the same exclusions server-side; this keeps them
    // enforced even if an upstream filter is ignored.
    media: media.flatMap((item) => {
      const manga = sanitizeAnilistMangaSummary(item);
      return manga && !isAnilistMangaExcluded(manga, policy) ? [manga] : [];
    }),
  };
};

const MAX_INT32 = 2_147_483_647;

export interface AnilistMalLinkPage {
  hasNextPage: boolean;
  links: { anilistId: number; malId: number }[];
}

/**
 * Undefined when the page is malformed, so the caller can leave the whole
 * batch unchecked. Rows for IDs that were not requested are dropped.
 */
export const sanitizeAnilistMalLinkPage = (
  value: unknown,
  requested: ReadonlySet<number>
): AnilistMalLinkPage | undefined => {
  if (
    !isRecord(value) ||
    !isRecord(value.pageInfo) ||
    typeof value.pageInfo.hasNextPage !== 'boolean' ||
    !Array.isArray(value.media) ||
    value.media.length > ANILIST_MAL_LOOKUP_PAGE_SIZE
  ) {
    return undefined;
  }
  const links: AnilistMalLinkPage['links'] = [];
  for (const item of value.media) {
    if (!isRecord(item)) {
      return undefined;
    }
    const anilistId = boundedInteger(item.id, 1, MAX_INT32);
    if (anilistId === undefined) {
      return undefined;
    }
    const malId = boundedInteger(item.idMal, 1, MAX_INT32);
    if (malId !== undefined && requested.has(malId)) {
      links.push({ anilistId, malId });
    }
  }
  return { hasNextPage: value.pageInfo.hasNextPage, links };
};

/**
 * Undefined when the reply is not a page of media at all. Rows for IDs that
 * were not requested, and rows that fail sanitizing, are dropped.
 */
export const sanitizeAnilistMangaBatch = (
  value: unknown,
  requested: ReadonlySet<number>
): AnilistMangaSummary[] | undefined => {
  if (!isRecord(value) || !Array.isArray(value.media)) {
    return undefined;
  }
  const seen = new Set<number>();
  return value.media.slice(0, ANILIST_MANGA_BATCH_SIZE).flatMap((item) => {
    const manga = sanitizeAnilistMangaSummary(item);
    if (!manga || !requested.has(manga.id) || seen.has(manga.id)) {
      return [];
    }
    seen.add(manga.id);
    return [manga];
  });
};

/** Undefined when the reply is not a page of media at all. */
export const sanitizeAnilistMangaSearch = (
  value: unknown,
  policy: AnilistMangaContentPolicy
): AnilistMangaSummary[] | undefined =>
  isRecord(value) && Array.isArray(value.media)
    ? sanitizeAnilistMangaPage(value, policy).media
    : undefined;

// A name must come back unchanged through the comma-separated discover
// parameters, so longer names and names with a comma are dropped.
const sanitizeFilterName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim();
  return name &&
    name.length <= MAX_ANILIST_FILTER_NAME_LENGTH &&
    !name.includes(',')
    ? name
    : undefined;
};

const sanitizeFilterOptionList = (
  items: unknown[],
  limit: number,
  read: (item: unknown) => AnilistMangaFilterOption | undefined
): AnilistMangaFilterOption[] => {
  const options = new Map<string, AnilistMangaFilterOption>();
  for (const item of items) {
    if (options.size >= limit) {
      break;
    }
    const option = read(item);
    if (option && !options.has(option.name)) {
      options.set(option.name, option);
    }
  }
  return [...options.values()];
};

/** Undefined when either list is missing from the reply. */
export const sanitizeAnilistMangaFilterOptions = (
  value: unknown
): AnilistMangaFilterOptions | undefined => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.GenreCollection) ||
    !Array.isArray(value.MediaTagCollection)
  ) {
    return undefined;
  }
  return {
    genres: sanitizeFilterOptionList(
      value.GenreCollection,
      MAX_ANILIST_FILTER_GENRES,
      (item) => {
        const name = sanitizeFilterName(item);
        return name
          ? { name, isAdult: ANILIST_ADULT_GENRES.has(name) }
          : undefined;
      }
    ),
    tags: sanitizeFilterOptionList(
      value.MediaTagCollection,
      MAX_ANILIST_FILTER_TAGS,
      (item) => {
        if (!isRecord(item)) {
          return undefined;
        }
        const name = sanitizeFilterName(item.name);
        // A tag without a clear adult flag counts as adult.
        return name ? { name, isAdult: item.isAdult !== false } : undefined;
      }
    ),
  };
};

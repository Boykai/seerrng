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
  'TRENDING_DESC' | 'POPULARITY_DESC' | 'SCORE_DESC' | 'SEARCH_MATCH';

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

export interface AnilistMangaContentPolicy {
  includeAdult: boolean;
  includeNovels: boolean;
}

export interface AnilistMangaPageOptions extends AnilistMangaContentPolicy {
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

/** Undefined when the reply is not a page of media at all. */
export const sanitizeAnilistMangaSearch = (
  value: unknown,
  policy: AnilistMangaContentPolicy
): AnilistMangaSummary[] | undefined =>
  isRecord(value) && Array.isArray(value.media)
    ? sanitizeAnilistMangaPage(value, policy).media
    : undefined;

import AnilistAPI, { AnilistGraphQLError } from '@server/api/anilist';
import type {
  AnilistMangaFilterOption,
  AnilistMangaSort,
} from '@server/api/anilist/manga';
import {
  ANILIST_MANGA_BATCH_SIZE,
  ANILIST_MANGA_COUNTRIES,
  ANILIST_MANGA_FORMATS,
  ANILIST_MANGA_STATUSES,
  isAnilistMangaExcluded,
} from '@server/api/anilist/manga';
import { extractImageCacheUrls } from '@server/lib/imageCacheUrls';
import { enqueueImageCacheWarm } from '@server/lib/imageCacheWarmer';
import {
  findMangaMediaByAnilistIds,
  getMangaContentPolicy,
  isMangaInSuwayomiLibrary,
  sendAnilistFailure,
} from '@server/lib/mangaCatalog';
import { parseMangaDiscoverFilters } from '@server/lib/mangaDiscoverFilters';
import logger from '@server/logger';
import { mapMangaDetails, mapMangaResult } from '@server/models/Manga';
import { filterEntityResponse } from '@server/utils/entityResponse';
import { getHttpErrorDetails } from '@server/utils/httpError';
import { parsePositiveInt } from '@server/utils/pagination';
import { parsePositiveRouteId } from '@server/utils/routeId';
import {
  parseOptionalAllowedString,
  parseOptionalBoundedString,
} from '@server/utils/validation';
import { Router } from 'express';

export const MANGA_DISCOVER_SORTS = [
  'trending',
  'popular',
  'top_rated',
  'popular.asc',
  'top_rated.asc',
  'start_date.desc',
  'start_date.asc',
  'title.asc',
  'title.desc',
] as const;
const MANGA_DISCOVER_SORT_ORDERS: Record<
  (typeof MANGA_DISCOVER_SORTS)[number],
  AnilistMangaSort[]
> = {
  trending: ['TRENDING_DESC', 'POPULARITY_DESC'],
  popular: ['POPULARITY_DESC'],
  top_rated: ['SCORE_DESC'],
  // The ID breaks ties, so titles with equal values keep their order from
  // one page to the next.
  'popular.asc': ['POPULARITY', 'ID'],
  'top_rated.asc': ['SCORE', 'ID'],
  'start_date.desc': ['START_DATE_DESC', 'ID_DESC'],
  'start_date.asc': ['START_DATE', 'ID'],
  'title.asc': ['TITLE_ROMAJI', 'ID'],
  'title.desc': ['TITLE_ROMAJI_DESC', 'ID_DESC'],
};
const MAX_MANGA_PAGE = 500;
const MAX_MANGA_QUERY_LENGTH = 256;
const MAX_MANGA_GENRE_LENGTH = 64;

type ParsedQueryValue<T> = { value: T | undefined } | { error: string };

const firstError = (
  ...results: ParsedQueryValue<unknown>[]
): string | undefined => {
  for (const result of results) {
    if ('error' in result) {
      return result.error;
    }
  }
  return undefined;
};

const valueOf = <T>(result: ParsedQueryValue<T>): T | undefined =>
  'value' in result ? result.value : undefined;

const mangaRoutes = Router();

const MAX_ANILIST_ID = 2_147_483_647;

// `ids` is a comma-separated list of 1-50 AniList IDs; duplicates collapse.
const parseMangaIdList = (value: unknown): number[] | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parts = value.split(',');
  if (parts.length > ANILIST_MANGA_BATCH_SIZE) {
    return undefined;
  }
  const ids = new Set<number>();
  for (const part of parts) {
    const id = /^[1-9]\d{0,9}$/.test(part) ? Number(part) : 0;
    if (id < 1 || id > MAX_ANILIST_ID) {
      return undefined;
    }
    ids.add(id);
  }
  return [...ids];
};

// Catalog cards for known AniList IDs in request order, one AniList request
// per call. Unknown and excluded titles are both left out, so the response
// does not reveal that an excluded title exists.
mangaRoutes.get('/', async (req, res) => {
  const ids = parseMangaIdList(req.query.ids);
  if (!ids) {
    return res.status(400).json({
      status: 400,
      message: `ids must list 1 to ${ANILIST_MANGA_BATCH_SIZE} AniList IDs separated by commas.`,
    });
  }

  const policy = getMangaContentPolicy();
  try {
    const visible = new Map(
      (await new AnilistAPI().getMangaSummariesByIds(ids))
        .filter((manga) => !isAnilistMangaExcluded(manga, policy))
        .map((manga) => [manga.id, manga])
    );
    const mediaByAnilistId = await findMangaMediaByAnilistIds(
      [...visible.keys()],
      req.user
    );
    const results = ids.flatMap((id) => {
      const manga = visible.get(id);
      return manga ? [mapMangaResult(manga, mediaByAnilistId.get(id))] : [];
    });
    const body = { results };
    enqueueImageCacheWarm(extractImageCacheUrls(body));
    return res.status(200).json(filterEntityResponse(body, req.user));
  } catch (e) {
    logger.error('Failed to retrieve manga summaries', {
      label: 'Manga',
      ...getHttpErrorDetails(e),
      count: ids.length,
    });
    return sendAnilistFailure(res, e, 'Unable to retrieve manga details.');
  }
});

mangaRoutes.get('/:id', async (req, res) => {
  const anilistId = parsePositiveRouteId(req.params.id);
  if (anilistId === undefined) {
    return res
      .status(400)
      .json({ status: 400, message: 'Manga id must be a positive integer.' });
  }

  const policy = getMangaContentPolicy();
  try {
    const manga = await new AnilistAPI().getMangaDetails(anilistId);
    // Excluded titles answer exactly like unknown ids, so the response does
    // not reveal that an excluded title exists.
    if (!manga || isAnilistMangaExcluded(manga, policy)) {
      return res.status(404).json({ status: 404, message: 'Manga not found.' });
    }
    const media = (await findMangaMediaByAnilistIds([anilistId], req.user)).get(
      anilistId
    );
    const details = {
      ...mapMangaDetails(manga, policy, media),
      inSuwayomiLibrary: await isMangaInSuwayomiLibrary(anilistId),
    };
    enqueueImageCacheWarm(extractImageCacheUrls(details));
    return res.status(200).json(filterEntityResponse(details, req.user));
  } catch (e) {
    logger.error('Failed to retrieve manga details', {
      label: 'Manga',
      ...getHttpErrorDetails(e),
      anilistId,
    });
    return sendAnilistFailure(res, e, 'Unable to retrieve manga details.');
  }
});

export const mangaDiscoverRoutes = Router();

mangaDiscoverRoutes.get('/', async (req, res) => {
  const page = parsePositiveInt(req.query.page, 1, MAX_MANGA_PAGE);
  const query = parseOptionalBoundedString(req.query.query, {
    fieldName: 'Query',
    maxLength: MAX_MANGA_QUERY_LENGTH,
  });
  const sortBy = parseOptionalAllowedString(req.query.sortBy, {
    fieldName: 'sortBy',
    allowedValues: MANGA_DISCOVER_SORTS,
    maxLength: 16,
  });
  const genre = parseOptionalBoundedString(req.query.genre, {
    fieldName: 'Genre',
    maxLength: MAX_MANGA_GENRE_LENGTH,
  });
  const format = parseOptionalAllowedString(req.query.format, {
    fieldName: 'format',
    allowedValues: ANILIST_MANGA_FORMATS,
    maxLength: 16,
  });
  const status = parseOptionalAllowedString(req.query.status, {
    fieldName: 'status',
    allowedValues: ANILIST_MANGA_STATUSES,
    maxLength: 32,
  });
  const countryOfOrigin = parseOptionalAllowedString(
    req.query.countryOfOrigin,
    {
      fieldName: 'countryOfOrigin',
      allowedValues: ANILIST_MANGA_COUNTRIES,
      maxLength: 2,
    }
  );
  const filters = parseMangaDiscoverFilters(
    req.query,
    valueOf(genre) || undefined
  );
  const error = firstError(
    query,
    sortBy,
    genre,
    format,
    status,
    countryOfOrigin,
    filters
  );
  if (error) {
    return res.status(400).json({ status: 400, message: error });
  }

  const policy = getMangaContentPolicy();
  if (valueOf(format) === 'NOVEL' && !policy.includeNovels) {
    return res
      .status(200)
      .json({ page, totalPages: 1, totalResults: 0, results: [] });
  }

  const search = valueOf(query) || undefined;
  const sortKey = valueOf(sortBy);
  const sort = sortKey
    ? MANGA_DISCOVER_SORT_ORDERS[sortKey]
    : search
      ? (['SEARCH_MATCH'] as AnilistMangaSort[])
      : MANGA_DISCOVER_SORT_ORDERS.trending;

  try {
    const response = await new AnilistAPI().getMangaPage({
      page,
      sort,
      search,
      genre: valueOf(genre) || undefined,
      format: valueOf(format),
      status: valueOf(status),
      countryOfOrigin: valueOf(countryOfOrigin),
      ...valueOf(filters),
      ...policy,
    });
    const mediaByAnilistId = await findMangaMediaByAnilistIds(
      response.media.map((manga) => manga.id),
      req.user
    );
    const results = response.media.map((manga) =>
      mapMangaResult(manga, mediaByAnilistId.get(manga.id))
    );
    const lastPage =
      response.pageInfo.lastPage ??
      (response.pageInfo.hasNextPage ? page + 1 : page);
    const body = {
      page,
      totalPages: Math.min(MAX_MANGA_PAGE, Math.max(1, lastPage)),
      totalResults: response.pageInfo.total ?? results.length,
      results,
    };
    enqueueImageCacheWarm(extractImageCacheUrls(body));
    return res.status(200).json(filterEntityResponse(body, req.user));
  } catch (e) {
    logger.error('Failed to retrieve manga discovery results', {
      label: 'Discover Manga',
      ...getHttpErrorDetails(e),
    });
    return sendAnilistFailure(
      res,
      e,
      'AniList, the service used for manga discovery, timed out or is unavailable. Please try again.'
    );
  }
});

// Genre, tag and format names for the discover filters. AniList's lists are
// cached and shared; the content policy is applied to every response, and a
// failure is logged by its codes only.
mangaDiscoverRoutes.get('/filters', async (_req, res) => {
  const policy = getMangaContentPolicy();
  const visibleNames = (options: AnilistMangaFilterOption[]) =>
    options
      .filter((option) => policy.includeAdult || !option.isAdult)
      .map((option) => option.name)
      .sort((a, b) => a.localeCompare(b, 'en'));

  try {
    const catalog = await new AnilistAPI().getMangaFilterOptions();
    return res.status(200).json({
      genres: visibleNames(catalog.genres),
      tags: visibleNames(catalog.tags),
      formats: ANILIST_MANGA_FORMATS.filter(
        (format) => policy.includeNovels || format !== 'NOVEL'
      ),
    });
  } catch (e) {
    const { errorCode, status } = getHttpErrorDetails(e);
    const failureStatus =
      status ?? (e instanceof AnilistGraphQLError ? e.status : undefined);
    logger.error('Failed to retrieve manga filter options', {
      label: 'Discover Manga',
      errorName: e instanceof Error ? e.name : 'UnknownError',
      ...(errorCode ? { errorCode } : {}),
      ...(failureStatus ? { status: failureStatus } : {}),
    });
    return sendAnilistFailure(
      res,
      e,
      'AniList, the service used for manga discovery, timed out or is unavailable. Please try again.'
    );
  }
});

export default mangaRoutes;

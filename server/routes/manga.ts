import AnilistAPI from '@server/api/anilist';
import type { AnilistMangaSort } from '@server/api/anilist/manga';
import {
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
  sendAnilistFailure,
} from '@server/lib/mangaCatalog';
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
] as const;
const MANGA_DISCOVER_SORT_ORDERS: Record<
  (typeof MANGA_DISCOVER_SORTS)[number],
  AnilistMangaSort[]
> = {
  trending: ['TRENDING_DESC', 'POPULARITY_DESC'],
  popular: ['POPULARITY_DESC'],
  top_rated: ['SCORE_DESC'],
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
    const details = mapMangaDetails(manga, policy, media);
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
  const error = firstError(
    query,
    sortBy,
    genre,
    format,
    status,
    countryOfOrigin
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

export default mangaRoutes;

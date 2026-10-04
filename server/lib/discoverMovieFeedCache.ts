import type { TmdbMovieResult } from '@server/api/themoviedb/interfaces';
import { getRepository } from '@server/datasource';
import { DiscoverMovieFeedSnapshot } from '@server/entity/DiscoverMovieFeedSnapshot';
import logger from '@server/logger';
import { createHash } from 'node:crypto';
import { In } from 'typeorm';

export interface DiscoverMovieFeedPage {
  page: number;
  totalPages: number;
  totalResults: number;
  results: TmdbMovieResult[];
}

export interface DiscoverMovieFeedCacheContext {
  shelf: 'popular' | 'upcoming';
  page: number;
  language: string;
  region: string;
  originalLanguage: string;
  includeAdult: boolean;
}

export const getMovieFeedShelf = (
  query: Record<string, unknown>
): DiscoverMovieFeedCacheContext['shelf'] | undefined => {
  const ignoredFields = new Set([
    'page',
    'language',
    'sortBy',
    'shuffleSeed',
    'primaryReleaseDateGte',
  ]);
  const hasAdditionalFilters = Object.entries(query).some(
    ([key, value]) => !ignoredFields.has(key) && value !== undefined
  );
  if (
    hasAdditionalFilters ||
    query.search ||
    query.availability ||
    query.primaryReleaseDateLte ||
    query.sortBy !== undefined
  ) {
    return undefined;
  }

  return query.primaryReleaseDateGte ? 'upcoming' : 'popular';
};

export interface CachedDiscoverMovieFeed {
  fetchedAt: Date;
  page: DiscoverMovieFeedPage;
}

export const DISCOVER_MOVIE_FEED_CACHE_MAX_ENTRIES = 256;
export const DISCOVER_MOVIE_FEED_CACHE_MAX_ENTRY_BYTES = 512 * 1024;
const MAX_CACHED_MOVIE_RESULTS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const getDiscoverMovieFeedCacheKey = (
  context: DiscoverMovieFeedCacheContext
): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        context.shelf,
        context.page,
        context.language,
        context.region,
        context.originalLanguage,
        context.includeAdult,
      ])
    )
    .digest('hex');

export const decodeDiscoverMovieFeedPage = (
  value: unknown
): DiscoverMovieFeedPage | undefined => {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.page) ||
    (value.page as number) < 1 ||
    !Number.isSafeInteger(value.totalPages) ||
    (value.totalPages as number) < 0 ||
    !Number.isSafeInteger(value.totalResults) ||
    (value.totalResults as number) < 0 ||
    !Array.isArray(value.results) ||
    value.results.length > MAX_CACHED_MOVIE_RESULTS
  ) {
    return undefined;
  }

  const validResults = value.results.every(
    (result) =>
      isRecord(result) &&
      Number.isSafeInteger(result.id) &&
      (result.id as number) > 0 &&
      typeof result.title === 'string' &&
      typeof result.original_title === 'string' &&
      (result.release_date === undefined ||
        typeof result.release_date === 'string') &&
      (result.overview === undefined || typeof result.overview === 'string') &&
      (result.genre_ids === undefined ||
        (Array.isArray(result.genre_ids) &&
          result.genre_ids.every((id) => Number.isSafeInteger(id)))) &&
      (result.poster_path === undefined ||
        typeof result.poster_path === 'string') &&
      (result.media_type === undefined || result.media_type === 'movie')
  );

  if (!validResults) return undefined;

  return value as unknown as DiscoverMovieFeedPage;
};

export const getCachedDiscoverMovieFeed = async (
  cacheKey: string
): Promise<CachedDiscoverMovieFeed | undefined> => {
  try {
    const repository = getRepository(DiscoverMovieFeedSnapshot);
    const record = await repository.findOne({ where: { cacheKey } });
    if (!record) return undefined;

    let decoded: unknown;
    try {
      decoded = JSON.parse(record.payload);
    } catch {
      await repository.delete({ cacheKey });
      return undefined;
    }
    const page = decodeDiscoverMovieFeedPage(decoded);
    if (!page) {
      await repository.delete({ cacheKey });
      return undefined;
    }

    return { fetchedAt: record.fetchedAt, page };
  } catch (error) {
    logger.warn('Unable to read cached movie discovery results', {
      label: 'Discover Cache',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

export const saveDiscoverMovieFeed = async (
  cacheKey: string,
  page: DiscoverMovieFeedPage,
  fetchedAt = new Date()
): Promise<void> => {
  const payload = JSON.stringify(page);
  if (
    Buffer.byteLength(payload, 'utf8') >
    DISCOVER_MOVIE_FEED_CACHE_MAX_ENTRY_BYTES
  ) {
    return;
  }

  try {
    const repository = getRepository(DiscoverMovieFeedSnapshot);
    await repository.upsert({ cacheKey, payload, fetchedAt }, ['cacheKey']);

    const records = await repository.find({
      order: { fetchedAt: 'DESC' },
      skip: DISCOVER_MOVIE_FEED_CACHE_MAX_ENTRIES,
      select: { cacheKey: true },
    });
    if (records.length > 0) {
      await repository.delete({
        cacheKey: In(records.map(({ cacheKey: oldKey }) => oldKey)),
      });
    }
  } catch (error) {
    logger.warn('Unable to save movie discovery results to cache', {
      label: 'Discover Cache',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
};

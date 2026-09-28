import TheMovieDb from '@server/api/themoviedb';
import type { TmdbExternalIdResponse } from '@server/api/themoviedb/interfaces';
import type { IdentityMappingCandidate } from './identityMappings';

export interface ExternalIdentityCandidate extends IdentityMappingCandidate {
  imdbId?: string;
  tvdbId?: number;
}

export function toPublicIdentityCandidate<T extends ExternalIdentityCandidate>(
  item: T
): Omit<T, 'imdbId' | 'tvdbId'> {
  const publicItem = { ...item };
  delete publicItem.imdbId;
  delete publicItem.tvdbId;
  return publicItem;
}

const MAX_CONCURRENT_EXTERNAL_LOOKUPS = 4;
const imdbPattern = /^tt\d{1,20}$/;

function resolveResult(
  response: TmdbExternalIdResponse,
  mediaType?: 'movie' | 'tv'
): { id: number; mediaType: 'movie' | 'tv' } | undefined {
  const movies = response.movie_results.filter(
    (item) => Number.isSafeInteger(item.id) && item.id > 0
  );
  const shows = response.tv_results.filter(
    (item) => Number.isSafeInteger(item.id) && item.id > 0
  );

  if (movies.length + shows.length !== 1) return;
  if (movies.length === 1)
    return mediaType === 'tv'
      ? undefined
      : { id: movies[0].id, mediaType: 'movie' };
  return mediaType === 'movie'
    ? undefined
    : { id: shows[0].id, mediaType: 'tv' };
}

async function resolveOne(
  tmdb: TheMovieDb,
  item: ExternalIdentityCandidate
): Promise<ExternalIdentityCandidate> {
  if (item.tmdbId || item.identityMapped) return item;

  const lookups: (
    { externalId: string; type: 'imdb' } | { externalId: number; type: 'tvdb' }
  )[] = [];
  if (item.imdbId && imdbPattern.test(item.imdbId))
    lookups.push({ externalId: item.imdbId, type: 'imdb' });
  if (
    item.mediaType !== 'movie' &&
    Number.isSafeInteger(item.tvdbId) &&
    Number(item.tvdbId) > 0
  )
    lookups.push({ externalId: Number(item.tvdbId), type: 'tvdb' });

  for (const lookup of lookups) {
    try {
      const match = resolveResult(
        await tmdb.getByExternalId(lookup),
        item.mediaType
      );
      if (!match) continue;

      const detail =
        match.mediaType === 'movie'
          ? await tmdb.getMovie({ movieId: match.id })
          : await tmdb.getTvShow({ tvId: match.id });
      if (detail.id !== match.id) continue;

      return {
        ...item,
        tmdbId: match.id,
        mediaType: match.mediaType,
        identityResolution: 'external-id',
      };
    } catch {
      // Provider outages and stale external IDs leave the title available for
      // the existing manual repair flow without failing the source feed.
    }
  }

  return item;
}

export async function resolveExternalIdentityMatches<
  T extends ExternalIdentityCandidate,
>(items: T[], client?: TheMovieDb): Promise<T[]> {
  if (
    !items.some(
      (item) =>
        !item.tmdbId &&
        !item.identityMapped &&
        ((typeof item.imdbId === 'string' && imdbPattern.test(item.imdbId)) ||
          (item.mediaType !== 'movie' &&
            Number.isSafeInteger(item.tvdbId) &&
            Number(item.tvdbId) > 0))
    )
  )
    return items;
  const tmdb = client ?? new TheMovieDb();
  const resolved: T[] = [];
  for (
    let offset = 0;
    offset < items.length;
    offset += MAX_CONCURRENT_EXTERNAL_LOOKUPS
  ) {
    const batch = await Promise.all(
      items
        .slice(offset, offset + MAX_CONCURRENT_EXTERNAL_LOOKUPS)
        .map((item) => resolveOne(tmdb, item))
    );
    resolved.push(...(batch as T[]));
  }
  return resolved;
}

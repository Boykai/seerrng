import type { MangaResult } from '@server/models/Manga';
import { useMemo } from 'react';
import useSWR from 'swr';

// Matches the server's batch limit for GET /api/v1/manga?ids=.
export const MANGA_SUMMARY_BATCH_SIZE = 50;

export interface MangaSummaries {
  summaries: ReadonlyMap<number, MangaResult>;
  isLoading: boolean;
  error: unknown;
}

const isAnilistId = (id: number): boolean =>
  Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;

// The commas are encoded because the API validator refuses raw commas.
export const mangaSummariesKey = (ids: readonly number[]): string | null => {
  const unique = [...new Set(ids.filter(isAnilistId))].slice(
    0,
    MANGA_SUMMARY_BATCH_SIZE
  );
  return unique.length > 0 ? `/api/v1/manga?ids=${unique.join('%2C')}` : null;
};

/**
 * Reads catalog cards for up to 50 AniList IDs in one request. IDs that are
 * unknown or hidden by the Manga Content settings are absent from the map.
 */
const useMangaSummaries = (ids: readonly number[]): MangaSummaries => {
  const key = mangaSummariesKey(ids);
  // A new page must not reuse the previous page's titles.
  const { data, error, isLoading } = useSWR<{ results: MangaResult[] }>(key, {
    keepPreviousData: false,
  });
  const results = key ? data?.results : undefined;
  const summaries = useMemo(
    () => new Map((results ?? []).map((manga) => [manga.id, manga])),
    [results]
  );

  return { summaries, isLoading: Boolean(key) && isLoading, error };
};

export default useMangaSummaries;

import type { WatchStatusResponse } from '@server/models/WatchStatus';
import useSWR from 'swr';

const useWatchStatus = (
  mediaType: 'movie' | 'tv',
  tmdbId?: number,
  enabled = true,
  details = false
) =>
  useSWR<WatchStatusResponse>(
    enabled && tmdbId
      ? `/api/v1/playback/watched/${mediaType}/${tmdbId}${details ? '?details=1' : ''}`
      : null,
    {
      shouldRetryOnError: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 60_000,
    }
  );

export default useWatchStatus;

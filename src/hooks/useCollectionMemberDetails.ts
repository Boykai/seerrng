import type { CollectionMemberDetails } from '@app/utils/collectionRatings';
import { mapWithConcurrency } from '@app/utils/concurrency';
import type { RatingResponse } from '@server/api/ratings';
import type { MovieDetails } from '@server/models/Movie';
import type { MovieResult } from '@server/models/Search';
import axios from 'axios';
import useSWR from 'swr';

const useCollectionMemberDetails = (parts: MovieResult[]) => {
  const ids = [...new Set(parts.map((part) => part.id))];
  return useSWR<CollectionMemberDetails[]>(
    ids.length ? ['collection-member-details', ids.join(',')] : null,
    () =>
      mapWithConcurrency(ids, 3, async (id) => {
        const [details, ratings] = await Promise.allSettled([
          axios.get<MovieDetails>(`/api/v1/movie/${id}`, { timeout: 20000 }),
          axios.get<RatingResponse>(`/api/v1/movie/${id}/ratingscombined`, {
            timeout: 20000,
          }),
        ]);
        const ratingFailed =
          ratings.status === 'rejected' &&
          !(
            axios.isAxiosError(ratings.reason) &&
            ratings.reason.response?.status === 404
          );
        return {
          id,
          details:
            details.status === 'fulfilled' ? details.value.data : undefined,
          ratings:
            ratings.status === 'fulfilled' ? ratings.value.data : undefined,
          failed: details.status === 'rejected' || ratingFailed,
        };
      }),
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );
};

export default useCollectionMemberDetails;

import useSWR from 'swr';

export type RequestCountResponse = {
  pending: number;
};

export const REQUEST_COUNT_REFRESH_INTERVAL = 30_000;
const REQUEST_COUNT_DEDUPING_INTERVAL = 5_000;

const useRequestCount = (enabled: boolean) =>
  useSWR<RequestCountResponse>(enabled ? '/api/v1/request/count' : null, {
    revalidateOnMount: true,
    revalidateOnFocus: false,
    dedupingInterval: REQUEST_COUNT_DEDUPING_INTERVAL,
    // Server-side request transitions cannot invalidate another open tab.
    refreshInterval: REQUEST_COUNT_REFRESH_INTERVAL,
  });

export default useRequestCount;

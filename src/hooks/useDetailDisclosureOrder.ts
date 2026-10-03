import { useUser } from '@app/hooks/useUser';
import {
  normalizeSeriesDisclosureOrder,
  type SeriesDisclosureRole,
} from '@server/utils/detailDisclosureOrder';
import axios from 'axios';
import { useCallback, useMemo, useRef } from 'react';
import useSWR from 'swr';

const useDetailDisclosureOrder = (enabled = true) => {
  const { user } = useUser();
  const userId = String(user?.id ?? '').match(/^[1-9]\d{0,8}$/)?.[0];
  const endpoint =
    enabled && userId
      ? `/api/v1/user/${userId}/settings/detail-disclosure-order/tv`
      : null;
  const { data, mutate } = useSWR<SeriesDisclosureRole[]>(endpoint, {
    revalidateOnFocus: false,
  });
  const order = useMemo(
    () =>
      normalizeSeriesDisclosureOrder(
        data ?? user?.settings?.detailDisclosureOrder?.tv
      ),
    [data, user?.settings?.detailDisclosureOrder?.tv]
  );
  const identity = useRef(endpoint);
  identity.current = endpoint;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const setOrder = useCallback(
    (next: SeriesDisclosureRole[]) => {
      if (!endpoint) return Promise.resolve();
      const original = order;
      const save = async () => {
        if (identity.current !== endpoint) return;
        await mutate(next, { revalidate: false });
        try {
          const response = await axios.post<SeriesDisclosureRole[]>(endpoint, {
            order: next,
          });
          if (identity.current === endpoint)
            await mutate(normalizeSeriesDisclosureOrder(response.data), {
              revalidate: false,
            });
        } catch (error) {
          if (identity.current === endpoint)
            await mutate(original, { revalidate: false });
          throw error;
        }
      };
      const result = queue.current.catch(() => undefined).then(save);
      queue.current = result;
      return result;
    },
    [endpoint, mutate, order]
  );
  return {
    order,
    setOrder,
    canReorder: Boolean(endpoint),
    preferenceKey: endpoint ?? 'read-only',
  };
};
export default useDetailDisclosureOrder;

import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import { MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type { CollectionSyncStatus } from '@server/interfaces/api/collectionSync';
import type { Collection } from '@server/models/Collection';
import type {
  CollectionKind,
  CuratedCollection,
} from '@server/models/CuratedCollection';
import axios from 'axios';
import { useEffect, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';

export interface CollectionAvailabilityResponse<T = Collection> {
  collection: T;
  sync: CollectionSyncStatus;
}

export const collectionHasMissing = (
  collection: Collection | CuratedCollection | undefined,
  include4k: boolean
): boolean =>
  !collection ||
  collection.parts.some(
    (part) =>
      part.mediaInfo?.status !== MediaStatus.AVAILABLE ||
      (include4k && part.mediaInfo?.status4k !== MediaStatus.AVAILABLE)
  );

const safeCollectionId = (
  id: string,
  kind: CollectionKind
): string | undefined => {
  const pattern =
    kind === 'music' ? /^[A-Za-z0-9_-]{1,128}$/ : /^[1-9]\d{0,8}$/;

  return id.match(pattern)?.[0];
};

const collectionEndpoint = (id: string, kind: CollectionKind): string => {
  const safeId = safeCollectionId(id, kind);
  if (!safeId || safeId !== id) {
    throw new Error('Invalid collection identifier.');
  }

  if (kind === 'movie') return `/api/v1/collection/${safeId}`;
  if (kind === 'tv') return `/api/v1/collection-catalog/tv/${safeId}`;
  return `/api/v1/collection-catalog/music/${safeId}`;
};

/** No manual refresh control. Hidden/offline pages do not poll. */
const useCollectionAvailability = <
  T extends Collection | CuratedCollection = Collection,
>(
  id: string,
  collection?: T,
  kind: CollectionKind = 'movie'
) => {
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const { mutate } = useSWRConfig();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () =>
      setVisible(document.visibilityState === 'visible' && navigator.onLine);
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const supported = [
    MediaServerType.PLEX,
    MediaServerType.JELLYFIN,
    MediaServerType.EMBY,
  ].includes(settings.currentSettings.mediaServerType);
  const enabled =
    supported && visible && !!user && safeCollectionId(id, kind) === id;
  const key =
    enabled && user
      ? (['collection-availability', user.id, kind, id] as const)
      : null;
  const result = useSWR<CollectionAvailabilityResponse<T>>(
    key,
    async () => {
      const endpoint = collectionEndpoint(id, kind);
      const response = await axios.post<CollectionAvailabilityResponse<T>>(
        `${endpoint}/availability`,
        {},
        { timeout: 60000 }
      );
      await mutate(endpoint, response.data.collection, {
        revalidate: false,
      });
      return response.data;
    },
    {
      refreshInterval: 0,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
      revalidateOnMount: true,
      dedupingInterval: 55000,
      shouldRetryOnError: false,
      keepPreviousData: false,
    }
  );
  const shouldPoll =
    hasPermission(Permission.ADMIN) ||
    collectionHasMissing(
      result.data?.collection ?? collection,
      settings.currentSettings.movie4kEnabled
    );
  const { isValidating, mutate: refresh } = result;
  useEffect(() => {
    if (!enabled || !shouldPoll) return;
    // SWR skips its normal interval after errors; explicit revalidation keeps
    // retrying on the agreed one-minute cadence without an aggressive retry loop.
    const timer = window.setInterval(() => {
      if (!isValidating) void refresh().catch(() => undefined);
    }, 60000);
    return () => window.clearInterval(timer);
  }, [enabled, shouldPoll, isValidating, refresh]);
  return { ...result, supported };
};

export default useCollectionAvailability;

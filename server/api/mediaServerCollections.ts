import {
  getJellyfinEmbySeriesCollections,
  setJellyfinEmbySeriesCollectionMembership,
} from '@server/api/jellyfinEmbySavedItems';
import {
  getPlexSeriesCollections,
  setPlexSeriesCollectionMembership,
} from '@server/api/plexCollections';
import { MediaServerType } from '@server/constants/server';
import { getSettings } from '@server/lib/settings';
import type {
  MediaServerCollectionContext,
  MediaServerCollectionsStatus,
} from '@server/models/MediaServerCollections';

export const isMediaServerCollectionId = (
  serverType: MediaServerType,
  value: unknown
): value is string => {
  if (typeof value !== 'string') return false;
  const numeric = /^[1-9]\d{0,19}$/.test(value);
  const guid =
    /^[a-f\d]{32}$/i.test(value) ||
    /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
  if (serverType === MediaServerType.PLEX) return numeric;
  if (serverType === MediaServerType.JELLYFIN) return guid;
  if (serverType === MediaServerType.EMBY) return numeric || guid;
  return false;
};

const unavailable = (
  serverType: MediaServerType,
  reason: NonNullable<MediaServerCollectionsStatus['reason']>
): MediaServerCollectionsStatus => ({
  serverType,
  available: false,
  reason,
  collections: [],
});

const contextUnavailable = (
  context: MediaServerCollectionContext,
  serverType: MediaServerType
): MediaServerCollectionsStatus | undefined => {
  if (
    ![
      MediaServerType.PLEX,
      MediaServerType.JELLYFIN,
      MediaServerType.EMBY,
    ].includes(serverType)
  )
    return unavailable(serverType, 'unsupported-server');
  if (
    serverType === MediaServerType.PLEX
      ? !context.user.plexToken || !context.user.plexId
      : !context.user.jellyfinAuthToken || !context.user.jellyfinUserId
  )
    return unavailable(serverType, 'account-not-linked');
  if (
    !Number.isSafeInteger(context.tmdbId) ||
    context.tmdbId <= 0 ||
    !isMediaServerCollectionId(serverType, context.itemId)
  )
    return unavailable(serverType, 'series-not-found');
  return undefined;
};

/** Context is resolved under application account authority, never from client IDs/tokens. */
export const getMediaServerSeriesCollections = async (
  context: MediaServerCollectionContext
): Promise<MediaServerCollectionsStatus> => {
  const serverType = getSettings().main.mediaServerType;
  const missing = contextUnavailable(context, serverType);
  if (missing) return missing;
  return serverType === MediaServerType.PLEX
    ? getPlexSeriesCollections(context)
    : getJellyfinEmbySeriesCollections(context);
};

export const setMediaServerSeriesCollectionMembership = async (
  context: MediaServerCollectionContext,
  collectionId: string,
  member: boolean
): Promise<MediaServerCollectionsStatus> => {
  const serverType = getSettings().main.mediaServerType;
  const missing = contextUnavailable(context, serverType);
  if (missing) return missing;
  if (
    !isMediaServerCollectionId(serverType, collectionId) ||
    typeof member !== 'boolean'
  )
    return unavailable(serverType, 'not-authorized');
  return serverType === MediaServerType.PLEX
    ? setPlexSeriesCollectionMembership(context, collectionId, member)
    : setJellyfinEmbySeriesCollectionMembership(context, collectionId, member);
};

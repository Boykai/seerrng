import { MediaServerType } from '@server/constants/server';
import type { User } from '@server/entity/User';

export const isWatchAheadMediaServer = (
  mediaServerType: MediaServerType
): boolean =>
  mediaServerType === MediaServerType.PLEX ||
  mediaServerType === MediaServerType.JELLYFIN ||
  mediaServerType === MediaServerType.EMBY;

export const hasWatchAheadMediaServerLink = (
  user: Partial<Pick<User, 'plexId' | 'jellyfinUserId'>>,
  mediaServerType: MediaServerType
): boolean => {
  switch (mediaServerType) {
    case MediaServerType.PLEX:
      return (
        Number.isSafeInteger(Number(user.plexId)) && Number(user.plexId) > 0
      );
    case MediaServerType.JELLYFIN:
    case MediaServerType.EMBY:
      return Boolean(user.jellyfinUserId);
    default:
      return false;
  }
};

export const isPlexPlaybackSessionForUser = (
  session: { userId?: string; username?: string },
  user: Partial<Pick<User, 'plexId' | 'plexUsername'>>
): boolean =>
  (user.plexId != null && session.userId === String(user.plexId)) ||
  (user.plexUsername != null &&
    session.username?.toLocaleLowerCase() ===
      user.plexUsername.toLocaleLowerCase());

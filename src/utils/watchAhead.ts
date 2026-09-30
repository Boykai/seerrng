import type { User } from '@app/hooks/useUser';
import { MediaServerType } from '@server/constants/server';

export const hasLinkedWatchAheadAccount = (
  user: Pick<User, 'plexId' | 'jellyfinUsername'> | undefined,
  mediaServerType: MediaServerType
): boolean => {
  switch (mediaServerType) {
    case MediaServerType.PLEX:
      return (
        Number.isSafeInteger(Number(user?.plexId)) && Number(user?.plexId) > 0
      );
    case MediaServerType.JELLYFIN:
    case MediaServerType.EMBY:
      return Boolean(user?.jellyfinUsername);
    default:
      return false;
  }
};

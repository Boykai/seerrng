import type { User } from '@app/hooks/useUser';
import { MediaServerType } from '@server/constants/server';

export const hasLinkedWatchAheadAccount = (
  user: Pick<User, 'plexUsername' | 'jellyfinUsername'> | undefined,
  mediaServerType: MediaServerType
): boolean => {
  switch (mediaServerType) {
    case MediaServerType.PLEX:
      return Boolean(user?.plexUsername);
    case MediaServerType.JELLYFIN:
    case MediaServerType.EMBY:
      return Boolean(user?.jellyfinUsername);
    default:
      return false;
  }
};

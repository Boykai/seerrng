import { hasPermission, Permission } from '@server/lib/permissions';

export type RetryRequestMediaType =
  'movie' | 'tv' | 'music' | 'book' | 'comic' | 'magazine' | 'manga';

interface RetryRequestPermissionInput {
  requestType: RetryRequestMediaType;
  is4k: boolean;
  requestedById: number;
  userId?: number;
  permissions: number;
}

const getRetryRequestPermissions = (
  requestType: RetryRequestMediaType,
  is4k: boolean
): Permission[] => {
  switch (requestType) {
    case 'movie':
      return is4k
        ? [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE]
        : [Permission.REQUEST, Permission.REQUEST_MOVIE];
    case 'tv':
      return is4k
        ? [Permission.REQUEST_4K, Permission.REQUEST_4K_TV]
        : [Permission.REQUEST, Permission.REQUEST_TV];
    case 'music':
      return [Permission.REQUEST, Permission.REQUEST_MUSIC];
    case 'book':
      return [Permission.REQUEST, Permission.REQUEST_BOOK];
    case 'comic':
      return [Permission.REQUEST, Permission.REQUEST_COMIC];
    case 'magazine':
      return [Permission.REQUEST, Permission.REQUEST_MAGAZINE];
    case 'manga':
      return [Permission.REQUEST, Permission.REQUEST_MANGA];
  }
};

export const canRetryRequest = ({
  requestType,
  is4k,
  requestedById,
  userId,
  permissions,
}: RetryRequestPermissionInput): boolean => {
  if (hasPermission(Permission.MANAGE_REQUESTS, permissions)) {
    return true;
  }

  if (userId === undefined || userId !== requestedById) {
    return false;
  }

  return hasPermission(
    getRetryRequestPermissions(requestType, is4k),
    permissions,
    { type: 'or' }
  );
};

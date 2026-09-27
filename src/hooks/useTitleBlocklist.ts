import { Permission, useUser } from '@app/hooks/useUser';
import {
  encodeApiPathSegment,
  normalizeExternalTitleId,
} from '@app/utils/apiPath';
import { MediaType } from '@server/constants/media';
import axios from 'axios';
import useSWR from 'swr';

export const getTitleBlocklistKey = (
  id: string | number | null | undefined,
  mediaType: MediaType
) => {
  if (id == null || id === '') return null;
  const external =
    mediaType === MediaType.BOOK ||
    mediaType === MediaType.MUSIC ||
    mediaType === MediaType.COMIC;
  const normalized = normalizeExternalTitleId(mediaType, id);
  if (
    !normalized ||
    (!external &&
      (!Number.isSafeInteger(Number(normalized)) || Number(normalized) <= 0))
  )
    return null;
  // Keep boolean membership separate from consumers caching the full entry.
  return `title-blocklist:/api/v1/blocklist/${encodeApiPathSegment(normalized)}?mediaType=${mediaType}`;
};

export const fetchTitleBlocklist = async (key: string): Promise<boolean> => {
  try {
    await axios.get(key.replace(/^title-blocklist:/, ''));
    return true;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404)
      return false;
    throw error;
  }
};

/** One canonical membership cache for detail pages and Manage.
 * Media availability and component-local overrides are not membership authority.
 * Publish only confirmed writes; SWR discards older in-flight reads on mutation.
 */
const useTitleBlocklist = (
  id: string | number | null | undefined,
  mediaType: MediaType,
  fallbackBlocked = false
) => {
  const { hasPermission } = useUser();
  const key = hasPermission(Permission.MANAGE_BLOCKLIST)
    ? getTitleBlocklistKey(id, mediaType)
    : null;
  const { data, error, mutate } = useSWR<boolean>(key, fetchTitleBlocklist, {
    shouldRetryOnError: false,
  });
  return {
    isBlocklisted: typeof data === 'boolean' ? data : fallbackBlocked,
    checking: !!key && data === undefined && !error,
    error,
    setBlocklisted: (blocked: boolean) =>
      mutate(blocked, { revalidate: false }),
  };
};

export default useTitleBlocklist;

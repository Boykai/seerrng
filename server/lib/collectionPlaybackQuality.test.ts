import { MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { expect, it, vi } from 'vitest';
import { resolveCollectionQualityCatalog } from './collectionPlaybackQuality';
const available = MediaStatus.AVAILABLE;
const missing = MediaStatus.UNKNOWN;
it.each([false, true])(
  'loads only the requested variant (4K=%s)',
  async (is4k) => {
    const catalog = {
      mediaId: 1,
      serverType: MediaServerType.PLEX,
      is4k,
      groups: [],
    };
    const load = vi.fn().mockResolvedValue(catalog);
    expect(
      await resolveCollectionQualityCatalog(
        { status: available, status4k: available },
        is4k,
        load
      )
    ).toBe(catalog);
    expect(load).toHaveBeenCalledExactlyOnceWith(is4k);
    // Even a catalog without a root must not fall back to the other quality.
  }
);
it.each([false, true])(
  'skips titles available only in the opposite quality (4K=%s)',
  async (is4k) => {
    const load = vi.fn();
    expect(
      await resolveCollectionQualityCatalog(
        {
          status: is4k ? available : missing,
          status4k: is4k ? missing : available,
        },
        is4k,
        load
      )
    ).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  }
);

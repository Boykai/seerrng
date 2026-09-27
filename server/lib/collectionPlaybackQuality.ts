import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { PlaybackCatalogResponse } from '@server/models/Playback';

export const resolveCollectionQualityCatalog = async (
  media: Pick<Media, 'status' | 'status4k'>,
  is4k: boolean,
  loadCatalog: (is4k: boolean) => Promise<PlaybackCatalogResponse>
): Promise<PlaybackCatalogResponse | undefined> => {
  const status = is4k ? media.status4k : media.status;
  if (
    status !== MediaStatus.AVAILABLE &&
    status !== MediaStatus.PARTIALLY_AVAILABLE
  )
    return undefined;
  // Do not try the other variant, even when the selected catalog has no root.
  return loadCatalog(is4k);
};

import { MediaStatus, MediaType } from '@server/constants/media';

// Partial library coverage is separate from the current transfer stage.
export const isIncompleteRequestStatus = (
  stage: string,
  mediaType?: MediaType,
  mediaStatus?: MediaStatus
): boolean =>
  stage === 'library' ||
  ((mediaType === MediaType.MOVIE || mediaType === MediaType.TV) &&
    mediaStatus === MediaStatus.PARTIALLY_AVAILABLE &&
    ['approved', 'searching', 'downloading', 'importing'].includes(stage));

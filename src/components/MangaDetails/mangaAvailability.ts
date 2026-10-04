import type { MediaAvailabilityTone } from '@app/components/MediaDetails/AvailabilityValue';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MediaStatus } from '@server/constants/media';
import type { MessageDescriptor } from 'react-intl';

export const mangaAvailabilityMessages = defineMessages(
  'components.MangaDetails',
  {
    inSuwayomiLibrary: 'In Suwayomi Library',
  }
);

export interface MangaAvailability {
  message: MessageDescriptor;
  tone: MediaAvailabilityTone;
}

// Downloaded chapters win; the library marker shows only without them.
export const getMangaAvailability = (
  status: MediaStatus | undefined,
  inSuwayomiLibrary: boolean | undefined
): MangaAvailability | undefined => {
  switch (status) {
    case MediaStatus.AVAILABLE:
      return { message: globalMessages.available, tone: 'available' };
    case MediaStatus.PARTIALLY_AVAILABLE:
      return { message: globalMessages.partiallyavailable, tone: 'available' };
    case MediaStatus.BLOCKLISTED:
      return undefined;
    default:
      return inSuwayomiLibrary
        ? {
            message: mangaAvailabilityMessages.inSuwayomiLibrary,
            tone: 'processing',
          }
        : undefined;
  }
};

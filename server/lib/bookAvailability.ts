import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';

export type BookFormat = 'ebook' | 'audiobook' | 'both';

export const hasAvailableBookFormat = (
  media: Media,
  format: Exclude<BookFormat, 'both'>
): boolean => {
  if (media.status !== MediaStatus.AVAILABLE) {
    return false;
  }

  if (format === 'audiobook') {
    return (
      (media.audiobookExternalServiceId !== null &&
        media.audiobookExternalServiceId !== undefined) ||
      (media.audiobookLibraryServiceId !== null &&
        media.audiobookLibraryServiceId !== undefined &&
        media.audiobookLibraryItemId !== null &&
        media.audiobookLibraryItemId !== undefined)
    );
  }

  return (
    media.externalServiceId !== null && media.externalServiceId !== undefined
  );
};

export const isRequestedBookFormatAvailable = (
  media: Media,
  format: BookFormat
): boolean => {
  const ebookAvailable = hasAvailableBookFormat(media, 'ebook');
  const audiobookAvailable = hasAvailableBookFormat(media, 'audiobook');

  if (format === 'both') {
    return ebookAvailable && audiobookAvailable;
  }

  return format === 'audiobook' ? audiobookAvailable : ebookAvailable;
};

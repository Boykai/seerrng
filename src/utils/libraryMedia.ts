import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';

type BookMediaInfo = {
  mediaInfo?: Media;
};

export const isBookInProgress = (title: BookMediaInfo) =>
  (title.mediaInfo?.downloadStatus ?? []).length > 0 ||
  (title.mediaInfo?.audiobookDownloadStatus ?? []).length > 0;

export const canRequestMissingBookFormat = (title: BookMediaInfo) => {
  if (!title.mediaInfo || title.mediaInfo.status === MediaStatus.BLOCKLISTED) {
    return false;
  }

  const hasEbookServiceLink =
    title.mediaInfo.serviceId !== null &&
    title.mediaInfo.serviceId !== undefined &&
    title.mediaInfo.externalServiceId !== null &&
    title.mediaInfo.externalServiceId !== undefined;
  const hasAudiobookServiceLink =
    (title.mediaInfo.audiobookServiceId !== null &&
      title.mediaInfo.audiobookServiceId !== undefined &&
      title.mediaInfo.audiobookExternalServiceId !== null &&
      title.mediaInfo.audiobookExternalServiceId !== undefined) ||
    (title.mediaInfo.audiobookLibraryServiceId !== null &&
      title.mediaInfo.audiobookLibraryServiceId !== undefined &&
      !!title.mediaInfo.audiobookLibraryItemId);
  const activeBookRequests =
    title.mediaInfo.requests?.filter(
      (request) =>
        request.status !== MediaRequestStatus.DECLINED &&
        request.status !== MediaRequestStatus.FAILED &&
        request.status !== MediaRequestStatus.COMPLETED
    ) ?? [];
  const hasActiveEbookRequest = activeBookRequests.some(
    (request) =>
      (request.bookFormat ?? 'ebook') === 'ebook' ||
      request.bookFormat === 'both'
  );
  const hasActiveAudiobookRequest = activeBookRequests.some(
    (request) =>
      request.bookFormat === 'audiobook' || request.bookFormat === 'both'
  );

  return (
    !(hasEbookServiceLink || hasActiveEbookRequest) ||
    !(hasAudiobookServiceLink || hasActiveAudiobookRequest)
  );
};

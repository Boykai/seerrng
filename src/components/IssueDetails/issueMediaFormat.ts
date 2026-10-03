import { MediaStatus, MediaType } from '@server/constants/media';

export type IssueMediaType =
  'movie' | 'tv' | 'music' | 'book' | 'comic' | 'magazine' | 'manga';
export type IssueQuality = 'hd' | '4k';

export const getIssueMediaAndFormatLabel = (
  mediaType: IssueMediaType | MediaType,
  is4k = false
): string => {
  switch (mediaType) {
    case MediaType.TV:
      return `Series · ${is4k ? '4K' : 'HD'}`;
    case MediaType.MOVIE:
      return `Movie · ${is4k ? '4K' : 'HD'}`;
    case MediaType.MUSIC:
      return 'Music · Album';
    case MediaType.COMIC:
    case 'comic':
      return 'Comic';
    case MediaType.MAGAZINE:
    case 'magazine':
      return 'Magazine';
    case MediaType.MANGA:
    case 'manga':
      return 'Manga';
    default:
      return 'Book';
  }
};

const isAvailableStatus = (status?: MediaStatus) =>
  status === MediaStatus.AVAILABLE ||
  status === MediaStatus.PARTIALLY_AVAILABLE;

export const getAvailableIssueQualities = (mediaInfo?: {
  status?: MediaStatus;
  status4k?: MediaStatus;
}): IssueQuality[] => [
  ...(isAvailableStatus(mediaInfo?.status) ? (['hd'] as const) : []),
  ...(isAvailableStatus(mediaInfo?.status4k) ? (['4k'] as const) : []),
];

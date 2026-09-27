import { MediaStatus } from '@server/constants/media';
import type { CuratedCollectionMember } from '@server/models/CuratedCollection';

export const memberCanPlayQuality = (
  part: CuratedCollectionMember,
  kind: 'tv' | 'music',
  high: boolean
) => {
  const media = part.mediaInfo;
  if (!media) return false;
  if (kind === 'music') {
    const selectedVariant = high
      ? media.ratingKeyFlac || media.jellyfinMediaIdFlac
      : media.ratingKeyMp3 || media.jellyfinMediaIdMp3;
    if (selectedVariant) return true;
    // Older library scans have a single, quality-agnostic root ID. Match the
    // server-side playback resolver: use it only until variant-specific IDs
    // have been recorded.
    const hasQualitySpecificRoot = Boolean(
      media.ratingKeyMp3 ||
      media.ratingKeyFlac ||
      media.jellyfinMediaIdMp3 ||
      media.jellyfinMediaIdFlac
    );
    return (
      !hasQualitySpecificRoot &&
      Boolean(media.ratingKey || media.jellyfinMediaId)
    );
  }
  return [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE].includes(
    high ? media.status4k : media.status
  );
};

export const memberHasQuality = (
  part: CuratedCollectionMember,
  kind: 'tv' | 'music',
  high: boolean
) =>
  (kind === 'music' &&
    part.availableQualities?.includes(high ? 'FLAC' : 'MP3')) ||
  memberCanPlayQuality(part, kind, high);

export const curatedPlaybackIds = (
  parts: CuratedCollectionMember[],
  selected: string[],
  kind: 'tv' | 'music',
  high: boolean
) =>
  parts
    .filter(
      (part) =>
        selected.includes(part.id) && memberCanPlayQuality(part, kind, high)
    )
    .map((part) => part.mediaInfo!.id);

export const reconcileCuratedSelection = (
  ids: string[],
  selected: string[],
  manuallySelected: boolean
) => (manuallySelected ? selected.filter((id) => ids.includes(id)) : [...ids]);

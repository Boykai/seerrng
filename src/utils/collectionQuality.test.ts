import { MediaStatus } from '@server/constants/media';
import { expect, it } from 'vitest';
import { collectionPartHasQuality } from './collectionPlaybackSelection';
const available = MediaStatus.AVAILABLE;
const missing = MediaStatus.UNKNOWN;
const parts = [
  { mediaInfo: { id: 1, status: available, status4k: missing } },
  { mediaInfo: { id: 2, status: missing, status4k: available } },
  { mediaInfo: { id: 3, status: available, status4k: available } },
  { mediaInfo: { id: 4, status: MediaStatus.PROCESSING, status4k: missing } },
];
it('includes only HD copies for HD and only 4K copies for 4K', () => {
  expect(
    parts
      .filter((p) => collectionPartHasQuality(p, 'hd'))
      .map((p) => p.mediaInfo.id)
  ).toEqual([1, 3]);
  expect(
    parts
      .filter((p) => collectionPartHasQuality(p, '4k'))
      .map((p) => p.mediaInfo.id)
  ).toEqual([2, 3]);
});
it('does not treat missing records or an unset quality as playable', () => {
  expect(collectionPartHasQuality({}, 'hd')).toBe(false);
  expect(collectionPartHasQuality(parts[0], undefined)).toBe(false);
});

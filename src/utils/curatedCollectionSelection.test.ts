import { MediaStatus } from '@server/constants/media';
import type { CuratedCollectionMember } from '@server/models/CuratedCollection';
import { describe, expect, it } from 'vitest';
import {
  curatedPlaybackIds,
  memberHasQuality,
  reconcileCuratedSelection,
} from './curatedCollectionSelection';

describe('shared TV/music selection', () => {
  it('shows saved MP3/FLAC availability without fabricating playback links', () => {
    const album = {
      id: 'album',
      availableQualities: ['MP3', 'FLAC'],
      mediaInfo: { id: 4711, status: MediaStatus.AVAILABLE },
    } as CuratedCollectionMember;
    expect(memberHasQuality(album, 'music', false)).toBe(true);
    expect(memberHasQuality(album, 'music', true)).toBe(true);
    expect(curatedPlaybackIds([album], ['album'], 'music', false)).toEqual([]);
    expect(curatedPlaybackIds([album], ['album'], 'music', true)).toEqual([]);
    album.availableQualities = ['FLAC'];
    expect(memberHasQuality(album, 'music', false)).toBe(false);
    expect(memberHasQuality(album, 'music', true)).toBe(true);
  });
  it('allows playback through a legacy music root until variant roots exist', () => {
    const album = {
      id: 'legacy-album',
      mediaInfo: { id: 4712, ratingKey: 'legacy-root' },
    } as CuratedCollectionMember;
    expect(
      curatedPlaybackIds([album], ['legacy-album'], 'music', false)
    ).toEqual([4712]);
    expect(
      curatedPlaybackIds([album], ['legacy-album'], 'music', true)
    ).toEqual([4712]);
    album.mediaInfo = {
      id: 4712,
      ratingKey: 'legacy-root',
      ratingKeyFlac: 'flac-root',
    } as CuratedCollectionMember['mediaInfo'];
    expect(
      curatedPlaybackIds([album], ['legacy-album'], 'music', false)
    ).toEqual([]);
    expect(
      curatedPlaybackIds([album], ['legacy-album'], 'music', true)
    ).toEqual([4712]);
  });
  const parts = [
    {
      id: 'a',
      mediaInfo: {
        id: 1,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
        ratingKeyMp3: '10',
      },
    },
    {
      id: 'b',
      mediaInfo: {
        id: 2,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.AVAILABLE,
        ratingKeyFlac: '20',
      },
    },
    { id: 'c' },
  ] as CuratedCollectionMember[];
  it('uses the same selected IDs but excludes unavailable playback qualities', () => {
    for (const kind of ['tv', 'music'] as const) {
      expect(curatedPlaybackIds(parts, ['a', 'b', 'c'], kind, false)).toEqual([
        1,
      ]);
      expect(curatedPlaybackIds(parts, ['a', 'b', 'c'], kind, true)).toEqual([
        2,
      ]);
      expect(curatedPlaybackIds(parts, ['b'], kind, false)).toEqual([]);
    }
  });
  it('starts with all items and preserves a manual selection during page refresh', () => {
    expect(reconcileCuratedSelection(['a', 'b', 'c'], [], false)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(
      reconcileCuratedSelection(['a', 'b', 'c', 'd'], ['a', 'b'], true)
    ).toEqual(['a', 'b']);
    expect(reconcileCuratedSelection(['a', 'b'], [], true)).toEqual([]);
  });
});

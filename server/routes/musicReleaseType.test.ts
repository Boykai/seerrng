import ListenBrainzAPI from '@server/api/listenbrainz';
import type { LbAlbumDetails } from '@server/api/listenbrainz/interfaces';
import MusicBrainz from '@server/api/musicbrainz';
import type { MbAlbumDetails } from '@server/api/musicbrainz/interfaces';
import { mapMusicDetails } from '@server/models/Music';
import { afterEach, expect, it, vi } from 'vitest';
import { getAlbumDetails } from './music';

afterEach(() => vi.restoreAllMocks());
const id = 'release-group-id';
it.each([false, true])(
  'preserves DJ-mix on details and request data (fallback=%s)',
  async (fallback) => {
    const listen = vi.spyOn(ListenBrainzAPI.prototype, 'getAlbum');
    if (fallback) listen.mockRejectedValue(new Error('unavailable'));
    else
      listen.mockResolvedValue({
        release_group_mbid: id,
        type: 'Album',
        mediums: [],
      } as unknown as LbAlbumDetails);
    vi.spyOn(MusicBrainz.prototype, 'getReleaseGroupDetails').mockResolvedValue(
      {
        id,
        title: 'DJ release',
        'primary-type': 'Album',
        'secondary-types': ['DJ-mix'],
      } as unknown as MbAlbumDetails
    );
    const details = await getAlbumDetails(
      id,
      new ListenBrainzAPI(),
      new MusicBrainz()
    );
    expect(mapMusicDetails(details).type).toBe('DJ-mix');
  }
);

it.each([
  [[], 'Album'],
  [['Live', 'Compilation'], 'Live · Compilation'],
])(
  'uses the same display labels as collection cards: %s',
  (secondaryTypes, label) => {
    expect(
      mapMusicDetails({
        release_group_mbid: id,
        type: 'Album',
        secondaryTypes,
        mediums: [],
      } as unknown as LbAlbumDetails).type
    ).toBe(label);
  }
);

it('retains usable album details if taxonomy lookup fails', async () => {
  const details = {
    release_group_mbid: id,
    type: 'Album',
    mediums: [],
  } as unknown as LbAlbumDetails;
  vi.spyOn(ListenBrainzAPI.prototype, 'getAlbum').mockResolvedValue(details);
  vi.spyOn(MusicBrainz.prototype, 'getReleaseGroupDetails').mockRejectedValue(
    new Error('timeout')
  );
  expect(
    await getAlbumDetails(id, new ListenBrainzAPI(), new MusicBrainz())
  ).toBe(details);
});

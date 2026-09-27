import TheAudioDb from '@server/api/theaudiodb';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ArtistArtworkMetadata,
  artistPosterFromMetadata,
  getArtistPoster,
} from './artistArtwork';

const id = '79239441-bfd5-4981-a70c-55c3f15c1287';
const poster = 'https://assets.fanart.tv/fanart/madonna.jpg';
afterEach(() => vi.restoreAllMocks());

it('selects the original artist poster rather than a logo or background', () => {
  expect(
    artistPosterFromMetadata(
      {
        id,
        images: [
          {
            CoverType: 'Logo',
            remoteUrl: 'https://assets.fanart.tv/fanart/logo.png',
          },
          { CoverType: 'Poster', remoteUrl: poster },
        ],
      },
      id
    )
  ).toBe(poster);
});

it.each([
  'http://assets.fanart.tv/fanart/a.jpg',
  'https://evil.example/fanart/a.jpg',
  'https://user@assets.fanart.tv/fanart/a.jpg',
  'https://assets.fanart.tv:8443/fanart/a.jpg',
  'invalid',
])('rejects untrusted image URL %s', (remoteUrl) => {
  expect(
    artistPosterFromMetadata(
      { id, images: [{ CoverType: 'Poster', remoteUrl }] },
      id
    )
  ).toBeUndefined();
});

it('rejects images belonging to a different artist', () => {
  expect(
    artistPosterFromMetadata(
      { id: 'other', images: [{ CoverType: 'Poster', remoteUrl: poster }] },
      id
    )
  ).toBeUndefined();
});

it('uses metadata artwork without requiring the local Lidarr library', async () => {
  vi.spyOn(ArtistArtworkMetadata.prototype, 'poster').mockResolvedValue(poster);
  const fallback = vi.spyOn(TheAudioDb.prototype, 'getArtistImages');
  expect(await getArtistPoster(id)).toBe(poster);
  expect(fallback).not.toHaveBeenCalled();
});

it.each([false, true])(
  'falls back on empty metadata or transient failure (%s)',
  async (failed) => {
    const primary = vi.spyOn(ArtistArtworkMetadata.prototype, 'poster');
    if (failed) primary.mockRejectedValue(new Error('timeout'));
    else primary.mockResolvedValue(undefined);
    vi.spyOn(TheAudioDb.prototype, 'getArtistImages').mockResolvedValue({
      artistThumb: 'https://r2.theaudiodb.com/artist.jpg',
      artistBackground: null,
    });
    expect(await getArtistPoster(id)).toBe(
      'https://r2.theaudiodb.com/artist.jpg'
    );
  }
);

it('does not request malformed artist identifiers', async () => {
  const primary = vi.spyOn(ArtistArtworkMetadata.prototype, 'poster');
  const fallback = vi.spyOn(TheAudioDb.prototype, 'getArtistImages');
  expect(await getArtistPoster('../bad')).toBeUndefined();
  expect(primary).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
});

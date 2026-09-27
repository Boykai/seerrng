import { describe, expect, it } from 'vitest';
import {
  buildArtistAutocompleteQuery,
  buildMusicAlbumSearchQuery,
  parseMusicSearchFilters,
} from './musicSearchFilters';

describe('catalogue music filters', () => {
  it('uses secondarytype for live, compilation and other shared release classifications', () => {
    expect(
      buildMusicAlbumSearchQuery('', { releaseType: 'Live,Compilation,EP' })
    ).toBe(
      '(secondarytype:"Live" OR secondarytype:"Compilation" OR primarytype:"EP")'
    );
    expect(buildMusicAlbumSearchQuery('', { releaseType: 'DJ-mix' })).toBe(
      '(secondarytype:"DJ-mix")'
    );
    expect(
      parseMusicSearchFilters({ releaseType: 'Imaginary type' })
    ).toHaveProperty('error');
    expect(parseMusicSearchFilters({ releaseType: 'Live' })).toHaveProperty(
      'value.releaseType',
      'Live'
    );
  });
  const artistId = '79239441-bfd5-4981-a70c-55c3f15c1287';
  it('combines exact artist, album words, year, genres and type before pagination', () => {
    const query = buildMusicAlbumSearchQuery('Ray of Light', {
      artistId,
      artist: 'Madonna',
      genre: 'pop,dance',
      releaseType: 'Album',
      primaryReleaseDateGte: '1998-01-01',
      primaryReleaseDateLte: '1998-12-31',
    });
    expect(query).toContain(`arid:"${artistId}"`);
    expect(query).not.toContain('artist:"Madonna"');
    expect(query).toContain('releasegroup:ray');
    expect(query).toContain('(tag:"pop" OR tag:"dance")');
    expect(query).toContain('primarytype:"Album"');
    expect(query).toContain('firstreleasedate:[1998-01-01 TO 1998-12-31]');
  });
  it('escapes quoted artist input and supports open date bounds', () => {
    expect(
      buildMusicAlbumSearchQuery('', {
        artist: 'A "B"',
        primaryReleaseDateLte: '1969-12-31',
      })
    ).toBe('artist:"A \\"B\\"" AND firstreleasedate:[* TO 1969-12-31]');
    expect(buildMusicAlbumSearchQuery('', { genre: ', ,' })).toBe('');
  });
  it('validates identifiers, calendar dates, repeated params and reversed ranges', () => {
    for (const query of [
      { artistId: 'bad' },
      { artist: ['a', 'b'] },
      { primaryReleaseDateGte: '2025-02-30' },
      {
        primaryReleaseDateGte: '1999-01-01',
        primaryReleaseDateLte: '1998-12-31',
      },
    ])
      expect(parseMusicSearchFilters(query)).toHaveProperty('error');
    expect(
      parseMusicSearchFilters({ artistId, primaryReleaseDateGte: '1998-01-01' })
    ).toHaveProperty('value.artistId', artistId);
  });
  it('searches partial artist names and escapes provider operators', () => {
    expect(buildArtistAutocompleteQuery('Mad')).toBe('artist:Mad*');
    expect(buildArtistAutocompleteQuery('Pink Fl')).toBe(
      'artist:Pink* AND artist:Fl*'
    );
    expect(buildArtistAutocompleteQuery('AC/DC')).toBe('artist:AC\\/DC*');
  });
});

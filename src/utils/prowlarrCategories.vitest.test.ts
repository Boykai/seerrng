import { describe, expect, it } from 'vitest';
import { detectProwlarrCategoryMatches } from './prowlarrCategories';

describe('detectProwlarrCategoryMatches', () => {
  const categories = [
    { id: 100_003, name: 'Audiobooks' },
    { id: 100_004, name: 'Comics' },
    { id: 100_005, name: 'eBooks' },
    { id: 100_007, name: 'Magazines' },
    { id: 100_012, name: 'Movies SD' },
    { id: 100_019, name: 'Movies' },
    { id: 100_002, name: 'TV' },
    { id: 100_031, name: 'Audio' },
    { id: 100_013, name: 'Adult Games' },
    { id: 100_015, name: 'Nintendo Switch' },
    { id: 100_016, name: 'PC Games' },
    { id: 100_017, name: 'PS5 ROMs' },
    { id: 100_018, name: 'Nintendo DS' },
    { id: 100_020, name: 'Nintendo 3DS' },
    { id: 100_021, name: 'Game Boy Advance' },
    { id: 100_022, name: 'Sega Genesis' },
    { id: 100_023, name: 'Atari 2600' },
    { id: 100_024, name: 'Nintendo Switch 2 ROMs' },
    { id: 3000, name: 'Audio' },
  ];

  it('matches clearly labeled custom book and media categories', () => {
    expect(detectProwlarrCategoryMatches('audiobook', categories)).toEqual([
      100_003,
    ]);
    expect(detectProwlarrCategoryMatches('comic', categories)).toEqual([
      100_004,
    ]);
    expect(detectProwlarrCategoryMatches('ebook', categories)).toEqual([
      100_005,
    ]);
    expect(detectProwlarrCategoryMatches('magazine', categories)).toEqual([
      100_007,
    ]);
    expect(detectProwlarrCategoryMatches('movie', categories)).toEqual([
      100_019,
    ]);
    expect(detectProwlarrCategoryMatches('tv', categories)).toEqual([100_002]);
  });

  it('keeps ambiguous and unrelated labels out of suggested mappings', () => {
    expect(detectProwlarrCategoryMatches('music', categories)).toEqual([]);
    expect(
      detectProwlarrCategoryMatches('tv', [
        { id: 100_020, name: 'Adult Shows' },
      ])
    ).toEqual([]);
    expect(detectProwlarrCategoryMatches('game', categories)).toEqual([
      100_016,
    ]);
  });

  it('detects console generations from explicit system names', () => {
    expect(detectProwlarrCategoryMatches('retro', categories)).toEqual([
      100_018, 100_020, 100_021, 100_022, 100_023,
    ]);
    expect(detectProwlarrCategoryMatches('modern', categories)).toEqual([
      100_015, 100_017, 100_024,
    ]);
  });

  it('does not suggest standard categories already covered by defaults', () => {
    expect(
      detectProwlarrCategoryMatches('music', [{ id: 3000, name: 'Audio' }])
    ).toEqual([]);
  });
});

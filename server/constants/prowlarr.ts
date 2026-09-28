import type { MediaCategoryKey } from '@server/constants/mediaCategories';

export type ProwlarrCategoryMappings = Record<MediaCategoryKey, number[]>;

/** Standard Newznab/Torznab categories used as safe defaults for manual search. */
export const DEFAULT_PROWLARR_CATEGORY_MAPPINGS: ProwlarrCategoryMappings = {
  movie: [2000],
  tv: [5000],
  music: [3010, 3020, 3040],
  ebook: [7020],
  audiobook: [3030],
  comic: [7030],
  magazine: [7010],
  retro: [1000, 4050],
  modern: [1000, 4050],
  game: [1000, 4050],
};

export const DEFAULT_PROWLARR_CATEGORY_LABELS: Record<number, string> = {
  1000: 'Console',
  1010: 'Console/NDS',
  1020: 'Console/PSP',
  1030: 'Console/Wii',
  1035: 'Console/Switch',
  1040: 'Console/Xbox',
  1050: 'Console/Xbox 360',
  1060: 'Console/WiiWare',
  1070: 'Console/Xbox 360 DLC',
  1080: 'Console/PS3',
  1090: 'Console/Xbox One',
  1100: 'Console/PS4',
  2000: 'Movies',
  3000: 'Audio',
  3010: 'Audio/MP3',
  3020: 'Audio/Video',
  3030: 'Audio/Audiobook',
  3040: 'Audio/Lossless',
  3050: 'Audio/Podcast',
  4000: 'PC',
  4050: 'PC/Games',
  5000: 'TV',
  7000: 'Books',
  7010: 'Books/Magazines',
  7020: 'Books/Ebooks',
  7030: 'Books/Comics',
};

export const defaultProwlarrCategoryMappings = (): ProwlarrCategoryMappings =>
  Object.fromEntries(
    Object.entries(DEFAULT_PROWLARR_CATEGORY_MAPPINGS).map(
      ([category, ids]) => [category, [...ids]]
    )
  ) as ProwlarrCategoryMappings;

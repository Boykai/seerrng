// Indexer-backed categories. This list doubles as the Prowlarr category key set.
export const MEDIA_CATEGORY_KEYS = [
  'movie',
  'tv',
  'music',
  'ebook',
  'audiobook',
  'comic',
  'magazine',
  'retro',
  'modern',
  'game',
] as const;

export type MediaCategoryKey = (typeof MEDIA_CATEGORY_KEYS)[number];

// Categories that only gate availability. They have no indexer category
// mapping, so they stay out of MEDIA_CATEGORY_KEYS.
export const AVAILABILITY_ONLY_MEDIA_CATEGORY_KEYS = ['manga'] as const;

export const MEDIA_AVAILABILITY_CATEGORY_KEYS = [
  ...MEDIA_CATEGORY_KEYS,
  ...AVAILABILITY_ONLY_MEDIA_CATEGORY_KEYS,
] as const;

export type MediaAvailabilityCategoryKey =
  (typeof MEDIA_AVAILABILITY_CATEGORY_KEYS)[number];
export type EnabledMediaCategories = Record<
  MediaAvailabilityCategoryKey,
  boolean
>;

export const DEFAULT_ENABLED_MEDIA_CATEGORIES: EnabledMediaCategories = {
  movie: true,
  tv: true,
  music: true,
  ebook: true,
  audiobook: true,
  comic: true,
  magazine: true,
  retro: true,
  modern: true,
  game: true,
  // Manga stays off until an administrator enables it.
  manga: false,
};

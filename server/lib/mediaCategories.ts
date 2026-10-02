import {
  DEFAULT_ENABLED_MEDIA_CATEGORIES,
  type MediaAvailabilityCategoryKey,
} from '@server/constants/mediaCategories';
import { getSettings } from '@server/lib/settings';

/**
 * A category missing from an older settings file resolves to its default:
 * existing categories stay enabled and newer opt-in categories stay disabled.
 */
export const isMediaCategoryEnabled = (
  category: MediaAvailabilityCategoryKey
): boolean => {
  const enabled = getSettings().main.enabledMediaCategories?.[category];

  return typeof enabled === 'boolean'
    ? enabled
    : DEFAULT_ENABLED_MEDIA_CATEGORIES[category];
};

export const areMediaCategoriesEnabled = (
  categories: readonly MediaAvailabilityCategoryKey[],
  mode: 'all' | 'any' = 'all'
): boolean =>
  mode === 'all'
    ? categories.every(isMediaCategoryEnabled)
    : categories.some(isMediaCategoryEnabled);

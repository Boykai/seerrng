import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_ENABLED_MEDIA_CATEGORIES,
  MEDIA_CATEGORY_KEYS,
  type EnabledMediaCategories,
} from '@server/constants/mediaCategories';
import {
  areMediaCategoriesEnabled,
  isMediaCategoryEnabled,
} from './mediaCategories';
import { getSettings } from './settings';

describe('isMediaCategoryEnabled', () => {
  let originalCategories: EnabledMediaCategories;

  beforeEach(() => {
    originalCategories = getSettings().main.enabledMediaCategories;
  });

  afterEach(() => {
    getSettings().main.enabledMediaCategories = originalCategories;
  });

  const setCategories = (categories: Partial<EnabledMediaCategories>) => {
    getSettings().main.enabledMediaCategories =
      categories as EnabledMediaCategories;
  };

  it('defaults manga off and every existing category on', () => {
    assert.strictEqual(DEFAULT_ENABLED_MEDIA_CATEGORIES.manga, false);
    for (const category of MEDIA_CATEGORY_KEYS) {
      assert.strictEqual(DEFAULT_ENABLED_MEDIA_CATEGORIES[category], true);
    }
  });

  it('keeps manga off for an older settings file without a manga key', () => {
    const olderCategories: Partial<EnabledMediaCategories> = {
      ...DEFAULT_ENABLED_MEDIA_CATEGORIES,
    };
    delete olderCategories.manga;
    setCategories(olderCategories);

    assert.strictEqual(isMediaCategoryEnabled('manga'), false);
    for (const category of MEDIA_CATEGORY_KEYS) {
      assert.strictEqual(isMediaCategoryEnabled(category), true);
    }
  });

  it('resolves every category to its default without saved flags', () => {
    setCategories({});
    assert.strictEqual(isMediaCategoryEnabled('manga'), false);
    for (const category of MEDIA_CATEGORY_KEYS) {
      assert.strictEqual(isMediaCategoryEnabled(category), true);
    }

    getSettings().main.enabledMediaCategories =
      undefined as unknown as EnabledMediaCategories;
    assert.strictEqual(isMediaCategoryEnabled('manga'), false);
    assert.strictEqual(isMediaCategoryEnabled('movie'), true);
  });

  it('honours explicit manga and existing category flags', () => {
    setCategories({ ...DEFAULT_ENABLED_MEDIA_CATEGORIES, manga: true });
    assert.strictEqual(isMediaCategoryEnabled('manga'), true);

    setCategories({
      ...DEFAULT_ENABLED_MEDIA_CATEGORIES,
      manga: false,
      comic: false,
    });
    assert.strictEqual(isMediaCategoryEnabled('manga'), false);
    assert.strictEqual(isMediaCategoryEnabled('comic'), false);
    assert.strictEqual(isMediaCategoryEnabled('magazine'), true);
  });

  it('combines manga with existing categories in all and any modes', () => {
    setCategories({ ...DEFAULT_ENABLED_MEDIA_CATEGORIES, manga: false });
    assert.strictEqual(areMediaCategoriesEnabled(['manga', 'comic']), false);
    assert.strictEqual(
      areMediaCategoriesEnabled(['manga', 'comic'], 'any'),
      true
    );
    assert.strictEqual(areMediaCategoriesEnabled(['manga'], 'any'), false);
  });
});

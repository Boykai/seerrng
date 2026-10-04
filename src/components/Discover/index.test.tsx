import { isDiscoverSliderEnabled } from '@app/components/Discover';
import type useSettings from '@app/hooks/useSettings';
import { DiscoverSliderType } from '@server/constants/discover';
import { describe, expect, it } from 'vitest';

type Settings = ReturnType<typeof useSettings>['currentSettings'];

const settings = (categories: Record<string, boolean>) =>
  ({ enabledMediaCategories: categories }) as unknown as Settings;

describe('isDiscoverSliderEnabled', () => {
  it('keeps Recently Added tied to movies and series while manga is off', () => {
    expect(
      isDiscoverSliderEnabled(
        DiscoverSliderType.RECENTLY_ADDED,
        settings({ movie: false, tv: false, manga: false })
      )
    ).toBe(false);
    expect(
      isDiscoverSliderEnabled(
        DiscoverSliderType.RECENTLY_ADDED,
        settings({ movie: false, tv: true, manga: false })
      )
    ).toBe(true);
  });

  it('shows Recently Added for manga alone, but not Trending', () => {
    const mangaOnly = settings({ movie: false, tv: false, manga: true });

    expect(
      isDiscoverSliderEnabled(DiscoverSliderType.RECENTLY_ADDED, mangaOnly)
    ).toBe(true);
    expect(
      isDiscoverSliderEnabled(DiscoverSliderType.TRENDING, mangaOnly)
    ).toBe(false);
  });
});

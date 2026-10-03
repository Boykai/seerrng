import Slider from '@app/components/Slider';
import TitleCard from '@app/components/TitleCard';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useDiscoverRowSnapshot from '@app/hooks/useDiscoverRowSnapshot';
import useMangaSummaries from '@app/hooks/useMangaSummaries';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import useWarmImageCache, {
  MAIN_MEDIA_POSTER_CACHE_WARM_LIMIT,
} from '@app/hooks/useWarmImageCache';
import defineMessages from '@app/utils/defineMessages';
import { getMangaImageUrl } from '@app/utils/mangaImages';
import type { OptionalServiceAvailability } from '@app/utils/serviceAvailability';
import { isConfiguredMediaCategoryEnabled } from '@app/utils/serviceAvailability';
import type { MediaResultsResponse } from '@server/interfaces/api/mediaInterfaces';
import { useMemo } from 'react';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';

const RECENTLY_ADDED_URL =
  '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded&mediaType=movie%2Ctv';

// The API lists manga only when asked and refuses disabled categories.
export const getRecentlyAddedUrl = (
  availability: Pick<OptionalServiceAvailability, 'enabledMediaCategories'>
): string => {
  if (!isConfiguredMediaCategoryEnabled('manga', availability)) {
    return RECENTLY_ADDED_URL;
  }

  const mediaTypes = (['movie', 'tv', 'manga'] as const).filter((type) =>
    isConfiguredMediaCategoryEnabled(type, availability)
  );

  return `/api/v1/media?filter=allavailable&take=20&sort=mediaAdded&mediaType=${mediaTypes.join('%2C')}`;
};

const messages = defineMessages('components.Discover.RecentlyAddedSlider', {
  recentlyAdded: 'Recently Added',
});

const RecentlyAddedSlider = () => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { currentSettings } = useSettings();
  const { ref, inView } = useInView({
    rootMargin: '450px 0px',
    triggerOnce: true,
  });
  const {
    data: media,
    error: mediaError,
    isLoading,
  } = useDiscoverRowSnapshot<MediaResultsResponse>({
    enabled: inView,
    personalized: true,
    rowKey: 'recently-added',
    url: getRecentlyAddedUrl(currentSettings),
  });
  const mangaEnabled = isConfiguredMediaCategoryEnabled(
    'manga',
    currentSettings
  );
  const manga = useMangaSummaries(
    mangaEnabled
      ? (media?.results ?? []).flatMap((item) =>
          item.mediaType === 'manga' && item.anilistId ? [item.anilistId] : []
        )
      : []
  );

  const recentlyAddedCards = useMemo(
    () =>
      (media?.results ?? []).flatMap((item) => {
        if (item.mediaType === 'manga') {
          const title =
            mangaEnabled && item.anilistId
              ? manga.summaries.get(item.anilistId)
              : undefined;

          // Titles hidden by the Manga Content settings are left out.
          return title
            ? [
                <TitleCard
                  key={`media-slider-item-${item.id}`}
                  id={title.id}
                  image={getMangaImageUrl(title.posterPath)}
                  status={item.status}
                  title={title.title}
                  year={title.startYear?.toString()}
                  mediaType="manga"
                />,
              ]
            : [];
        }

        if (
          (item.mediaType !== 'movie' && item.mediaType !== 'tv') ||
          !isConfiguredMediaCategoryEnabled(
            item.mediaType === 'tv' ? 'tv' : 'movie',
            currentSettings
          )
        ) {
          return [];
        }

        return [
          <TmdbTitleCard
            key={`media-slider-item-${item.id}`}
            id={item.id}
            tmdbId={item.tmdbId}
            tvdbId={item.tvdbId}
            type={item.mediaType === 'tv' ? 'tv' : 'movie'}
          />,
        ];
      }),
    [currentSettings, manga.summaries, mangaEnabled, media?.results]
  );

  useWarmImageCache(media?.results, {
    maxUrls: MAIN_MEDIA_POSTER_CACHE_WARM_LIMIT,
    posterOnly: true,
  });

  if (
    !hasPermission([Permission.MANAGE_REQUESTS, Permission.RECENT_VIEW], {
      type: 'or',
    })
  ) {
    return null;
  }

  return (
    <div ref={ref}>
      <div className="slider-header">
        <div className="slider-title">
          <span>{intl.formatMessage(messages.recentlyAdded)}</span>
        </div>
      </div>
      <Slider
        sliderKey="media"
        isLoading={
          isLoading || (manga.isLoading && recentlyAddedCards.length === 0)
        }
        isEmpty={
          !!media &&
          !manga.isLoading &&
          !recentlyAddedCards.length &&
          !mediaError
        }
        items={recentlyAddedCards}
      />
    </div>
  );
};

export default RecentlyAddedSlider;

import RTAudFresh from '@app/assets/rt_aud_fresh.svg';
import RTAudRotten from '@app/assets/rt_aud_rotten.svg';
import RTFresh from '@app/assets/rt_fresh.svg';
import RTRotten from '@app/assets/rt_rotten.svg';
import ImdbLogo from '@app/assets/services/imdb.svg';
import TmdbLogo from '@app/assets/tmdb_logo.svg';
import CollectionNavigation from '@app/components/CollectionDetails/CollectionNavigation';
import CachedImage from '@app/components/Common/CachedImage';
import PlayOnDeviceButton from '@app/components/Common/PlayOnDeviceButton';
import Tooltip from '@app/components/Common/Tooltip';
import WatchedBadge from '@app/components/Common/WatchedBadge';
import AvailabilityValue from '@app/components/MediaDetails/AvailabilityValue';
import DetailDisclosureButton from '@app/components/MediaDetails/DetailDisclosureButton';
import ExpandableCreditList from '@app/components/MediaDetails/ExpandableCreditList';
import MdblistRatingBadges from '@app/components/MediaDetails/MdblistRatingBadges';
import MediaDetailArtwork from '@app/components/MediaDetails/MediaDetailArtwork';
import MediaQualitySelect from '@app/components/MediaDetails/MediaQualitySelect';
import SeriesSeasonEpisodeBrowser from '@app/components/MediaDetails/SeriesSeasonEpisodeBrowser';
import { subjectTagClassName } from '@app/components/MediaDetails/subjectTagStyle';
import MediaSlider from '@app/components/MediaSlider';
import useDetailDisclosurePins from '@app/hooks/useDetailDisclosurePins';
import useLocale from '@app/hooks/useLocale';
import usePlaybackCatalog from '@app/hooks/usePlaybackCatalog';
import useWatchStatus from '@app/hooks/useWatchStatus';
import defineMessages from '@app/utils/defineMessages';
import { getTmdbPosterImageUrl } from '@app/utils/imageCache';
import { resolveCanonicalPlaybackSelection } from '@app/utils/playbackSelection';
import { getSafeHref } from '@app/utils/safeUrl';
import { getEffectiveVideoRatings } from '@app/utils/videoRatings';
import type { RatingResponse } from '@server/api/ratings';
import { MediaStatus } from '@server/constants/media';
import type { TvDetails } from '@server/models/Tv';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.TvDetails.Layout', {
  mediaAndFormat: 'Media & Format',
  firstAirDate: 'First Air Date',
  episodeRuntime: 'Episode Runtime',
  genres: 'Genres',
  creator: 'Creator',
  network: 'Network',
  seriesType: 'Series Type',
  hd: 'HD',
  ultraHd: '4K',
  watched: 'Watched',
  overview: 'Overview',
  overviewUnavailable: 'Overview unavailable',
  viewCast: 'Cast',
  viewCrew: 'Crew',
  subjectTags: 'Subject Tags',
  fullCastList: 'Full Cast List',
  fullCrewList: 'Full Crew List',
  noCast: 'No cast information available',
  noCrew: 'No crew information available',
  noTags: 'No subject tags available',
  seriesDetails: 'Details',
  status: 'Status',
  airDates: 'Air Dates',
  first: 'First',
  last: 'Last',
  next: 'Next',
  language: 'Language',
  country: 'Country',
  networks: 'Networks',
  notAvailable: 'Not Available',
  minutes: '{minutes} minutes',
  recommendations: 'Recommendations',
  similar: 'Similar Series',
  rtCriticsScore: 'Rotten Tomatoes Tomatometer',
  rtAudienceScore: 'Rotten Tomatoes Audience Score',
  imdbUserScore: 'IMDb user score – votes: {formattedCount}',
  imdbScore: 'IMDb user score',
  tmdbUserScore: 'TMDB User Score',
  quality: 'Quality',
});

interface SeriesDetailsLayoutProps {
  data: TvDetails;
  ratingData?: RatingResponse;
  sortedCrew: TvDetails['credits']['crew'];
  show4kAvailability: boolean;
  visibleSeasons: TvDetails['seasons'];
  primaryActions: ReactNode;
  secondaryActions: ReactNode;
  playbackActions?: (itemIds: string[], is4k: boolean) => ReactNode;
}

const availableStatuses = new Set([
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.AVAILABLE,
]);

const getAvailabilityText = (
  status: MediaStatus | undefined,
  unavailable: string
) => {
  switch (status) {
    case MediaStatus.AVAILABLE:
      return 'Available';
    case MediaStatus.PARTIALLY_AVAILABLE:
      return 'Partially Available';
    case MediaStatus.PROCESSING:
      return 'Processing';
    case MediaStatus.PENDING:
      return 'Requested';
    case MediaStatus.BLOCKLISTED:
      return 'Blocklisted';
    default:
      return unavailable;
  }
};

const SeriesDetailsLayout = ({
  data,
  ratingData,
  sortedCrew,
  show4kAvailability,
  visibleSeasons,
  primaryActions,
  secondaryActions,
  playbackActions,
}: SeriesDetailsLayoutProps) => {
  const intl = useIntl();
  const { locale } = useLocale();
  const effectiveRatings = getEffectiveVideoRatings(ratingData);
  const { data: watchedStatus } = useWatchStatus(
    'tv',
    data.id,
    Boolean(data.mediaInfo),
    true
  );
  const { pins, togglePinned } = useDetailDisclosurePins('tv');
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => {
    setShowDetails(pins.details);
  }, [pins.details, data.id]);
  const [showCast, setShowCast] = useState(false);
  const [showCrew, setShowCrew] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [selectedQuality, setSelectedQuality] = useState<'hd' | '4k'>(() =>
    show4kAvailability &&
    !availableStatuses.has(data.mediaInfo?.status as MediaStatus) &&
    availableStatuses.has(data.mediaInfo?.status4k as MediaStatus)
      ? '4k'
      : 'hd'
  );
  const effectiveSelectedQuality =
    show4kAvailability && selectedQuality === '4k' ? '4k' : 'hd';
  useEffect(() => {
    if (!show4kAvailability && selectedQuality !== 'hd') {
      setSelectedQuality('hd');
    }
  }, [selectedQuality, show4kAvailability]);
  useEffect(() => {
    setShowCast(pins.cast);
  }, [pins.cast]);
  useEffect(() => {
    setShowCrew(pins.crew);
  }, [pins.crew]);
  useEffect(() => {
    setShowTags(pins.subjectTags);
  }, [pins.subjectTags]);
  const [selectedPlaybackItemIds, setSelectedPlaybackItemIds] = useState<
    string[]
  >([]);
  const { data: standardPlaybackCatalog } = usePlaybackCatalog(
    data.mediaInfo?.id
  );
  const { data: highQualityPlaybackCatalog } = usePlaybackCatalog(
    show4kAvailability ? data.mediaInfo?.id : undefined,
    true
  );
  const playbackCatalog =
    effectiveSelectedQuality === '4k'
      ? highQualityPlaybackCatalog
      : standardPlaybackCatalog;
  useEffect(() => {
    const allowedIds = new Set(
      playbackCatalog?.groups.flatMap((group) =>
        group.items.map((item) => item.id)
      ) ?? []
    );
    setSelectedPlaybackItemIds((current) =>
      current.filter((itemId) => allowedIds.has(itemId))
    );
  }, [playbackCatalog]);
  const availablePlaybackItemIds =
    playbackCatalog?.groups.flatMap((group) =>
      group.items.map((item) => item.id)
    ) ?? [];
  const effectivePlaybackItemIds = resolveCanonicalPlaybackSelection(
    availablePlaybackItemIds,
    selectedPlaybackItemIds
  );
  const unavailable = intl.formatMessage(messages.notAvailable);
  const creators = data.createdBy;
  const featuredCrew = [
    ...creators.map((person) => ({ ...person, job: 'Creator' })),
    ...sortedCrew,
  ].slice(0, 6);
  const featuredCrewGroups = [0, 1, 2].map((column) =>
    [featuredCrew[column], featuredCrew[column + 3]].filter(Boolean)
  );
  const castCredits = useMemo(
    () =>
      data.credits.cast.map((person) => ({
        id: person.id,
        name: person.name,
        role: person.character,
        profilePath: person.profilePath,
      })),
    [data.credits.cast]
  );
  const crewCredits = useMemo(
    () =>
      data.credits.crew.map((person) => ({
        id: person.id,
        name: person.name,
        role: person.job,
        profilePath: person.profilePath,
      })),
    [data.credits.crew]
  );
  const originalLanguage =
    intl.formatDisplayName(data.originalLanguage, {
      type: 'language',
      fallback: 'none',
    }) ??
    data.spokenLanguages.find(
      (language) => language.iso_639_1 === data.originalLanguage
    )?.name ??
    unavailable;
  const availableFormats = [
    availableStatuses.has(data.mediaInfo?.status as MediaStatus)
      ? 'HD'
      : undefined,
    availableStatuses.has(data.mediaInfo?.status4k as MediaStatus)
      ? '4K'
      : undefined,
  ].filter(Boolean);
  const mediaAndFormat = `Series${
    availableFormats.length > 0 ? ` · ${availableFormats.join(' + ')}` : ''
  }`;
  const airDates = [
    data.firstAirDate
      ? { label: messages.first, value: data.firstAirDate }
      : undefined,
    data.lastAirDate && data.lastAirDate !== data.firstAirDate
      ? { label: messages.last, value: data.lastAirDate }
      : undefined,
    data.nextEpisodeToAir?.airDate &&
    data.nextEpisodeToAir.airDate !== data.lastAirDate
      ? { label: messages.next, value: data.nextEpisodeToAir.airDate }
      : undefined,
  ].filter(
    (item): item is { label: typeof messages.first; value: string } => !!item
  );

  return (
    <div className="media-page">
      <article className="media-detail-card app-card-main refreshed-card-surface refreshed-detail-text relative overflow-hidden rounded-xl border border-gray-700 p-3 shadow-lg shadow-gray-950/20">
        {data.backdropPath && (
          <MediaDetailArtwork
            type="tmdb"
            src={`https://image.tmdb.org/t/p/original${data.backdropPath}`}
          />
        )}

        <div className="relative z-10">
          <div className="app-card-inset refreshed-inset-surface detail-summary-card grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-3 sm:grid-cols-[80px_minmax(0,1fr)]">
            <div
              className="relative h-24 w-16 overflow-hidden rounded-lg ring-1 ring-gray-600 sm:h-[120px] sm:w-20"
              data-testid="media-details-poster"
            >
              <CachedImage
                type="tmdb"
                src={
                  getTmdbPosterImageUrl(data.posterPath) ||
                  '/images/seerr_poster_not_found.png'
                }
                alt=""
                fill
                priority
                sizes="(min-width: 640px) 80px, 64px"
                className="object-cover"
              />
            </div>

            <div className="flex min-w-0 flex-col">
              <h1
                className="detail-summary-title text-lg leading-5 font-semibold text-white"
                data-testid="media-title"
              >
                {data.name}
                {data.firstAirDate ? ` (${data.firstAirDate.slice(0, 4)})` : ''}
              </h1>

              <div className="detail-card-heading-spacing detail-three-column-grid grid min-w-0 flex-1">
                <div className="detail-paired-column-span min-w-0">
                  <dl className="media-detail-rows detail-paired-columns grid min-w-0 content-start text-xs">
                    <dt className="card:col-start-1 card:row-start-1 font-medium text-gray-100">
                      {intl.formatMessage(messages.mediaAndFormat)}:
                    </dt>
                    <dd className="card:col-start-3 card:row-start-1 m-0 truncate">
                      {mediaAndFormat}
                    </dd>
                    <dt className="card:col-start-1 card:row-start-2 font-medium text-gray-100">
                      {intl.formatMessage(messages.firstAirDate)}:
                    </dt>
                    <dd className="card:col-start-3 card:row-start-2 m-0 truncate">
                      {data.firstAirDate
                        ? intl.formatDate(data.firstAirDate, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            timeZone: 'UTC',
                          })
                        : unavailable}
                    </dd>
                    <dt className="card:col-start-1 card:row-start-3 font-medium text-gray-100">
                      {intl.formatMessage(messages.episodeRuntime)}:
                    </dt>
                    <dd className="card:col-start-3 card:row-start-3 m-0 truncate">
                      {data.episodeRunTime[0]
                        ? intl.formatMessage(messages.minutes, {
                            minutes: data.episodeRunTime[0],
                          })
                        : unavailable}
                    </dd>
                    <div className="media-detail-rows media-detail-column-divider card:col-span-1 card:col-start-5 card:row-span-3 card:row-start-1 col-span-2 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3">
                      <dt className="font-medium text-gray-100">
                        {intl.formatMessage(messages.creator)}:
                      </dt>
                      <dd className="m-0 truncate">
                        {creators.length > 0
                          ? creators.slice(0, 2).map((person, index) => (
                              <span key={person.id}>
                                {index > 0 && ', '}
                                <Link
                                  href={`/person/${person.id}`}
                                  className="text-indigo-300 hover:text-indigo-200 hover:underline focus:ring-2 focus:ring-indigo-400 focus:outline-none"
                                >
                                  {person.name}
                                </Link>
                              </span>
                            ))
                          : unavailable}
                      </dd>
                      <dt className="font-medium text-gray-100">
                        {intl.formatMessage(messages.network)}:
                      </dt>
                      <dd className="m-0 truncate">
                        {data.networks[0] ? (
                          <Link
                            href={`/discover/tv/network/${data.networks[0].id}`}
                            className="text-indigo-300 hover:text-indigo-200 hover:underline focus:ring-2 focus:ring-indigo-400 focus:outline-none"
                          >
                            {data.networks[0].name}
                          </Link>
                        ) : (
                          unavailable
                        )}
                      </dd>
                      <dt className="font-medium text-gray-100">
                        {intl.formatMessage(messages.seriesType)}:
                      </dt>
                      <dd className="m-0 truncate">
                        {data.type || unavailable}
                      </dd>
                    </div>

                    <dt className="card:col-start-1 card:row-start-4 font-medium text-gray-100">
                      {intl.formatMessage(messages.genres)}:
                    </dt>
                    <dd
                      className="card:col-span-3 card:col-start-3 card:row-start-4 m-0 min-w-0 break-words"
                      data-testid="media-details-genres"
                    >
                      {data.genres.length > 0
                        ? data.genres.map((genre, index) => (
                            <span key={genre.id}>
                              {index > 0 && ', '}
                              <Link
                                href={`/discover/tv?genre=${genre.id}`}
                                className="text-indigo-300 hover:text-indigo-200 hover:underline focus:ring-2 focus:ring-indigo-400 focus:outline-none"
                              >
                                {genre.name}
                              </Link>
                            </span>
                          ))
                        : unavailable}
                    </dd>
                  </dl>
                </div>

                <div className="media-detail-column-divider flex min-w-0 flex-col text-xs leading-4">
                  <dl className="media-detail-rows grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3">
                    <dt className="font-medium text-gray-100">
                      {intl.formatMessage(messages.hd)}:
                    </dt>
                    <dd className="m-0 truncate">
                      <AvailabilityValue status={data.mediaInfo?.status}>
                        {getAvailabilityText(
                          data.mediaInfo?.status,
                          unavailable
                        )}
                      </AvailabilityValue>
                    </dd>
                    {show4kAvailability && (
                      <>
                        <dt className="font-medium text-gray-100">
                          {intl.formatMessage(messages.ultraHd)}:
                        </dt>
                        <dd className="m-0 truncate">
                          <AvailabilityValue status={data.mediaInfo?.status4k}>
                            {getAvailabilityText(
                              data.mediaInfo?.status4k,
                              unavailable
                            )}
                          </AvailabilityValue>
                        </dd>
                      </>
                    )}
                    {!!watchedStatus?.availableCount && (
                      <>
                        <dt className="card:row-start-5 font-medium text-gray-100">
                          {intl.formatMessage(messages.watched)}:
                        </dt>
                        <dd className="card:row-start-5 m-0">
                          <WatchedBadge
                            status={watchedStatus}
                            className="detail-watched-button"
                            showUnwatched
                            incompleteLibrary={
                              data.mediaInfo?.status ===
                                MediaStatus.PARTIALLY_AVAILABLE ||
                              (data.mediaInfo?.status !==
                                MediaStatus.AVAILABLE &&
                                data.mediaInfo?.status4k ===
                                  MediaStatus.PARTIALLY_AVAILABLE)
                            }
                          />
                        </dd>
                      </>
                    )}
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <SeriesSeasonEpisodeBrowser
            tvId={data.id}
            seasons={visibleSeasons}
            catalog={playbackCatalog}
            watchedStatus={watchedStatus}
            selectedItemIds={selectedPlaybackItemIds}
            onSelectionChange={setSelectedPlaybackItemIds}
          />

          {(playbackActions ||
            effectiveRatings.rtCriticsScore !== undefined ||
            effectiveRatings.rtAudienceScore !== undefined ||
            effectiveRatings.imdbScore !== undefined ||
            ratingData?.mdblist?.metacriticRating !== undefined ||
            ratingData?.mdblist?.traktRating !== undefined ||
            data.voteCount > 0) && (
            <div className="media-rating-row">
              <MediaQualitySelect
                value={effectiveSelectedQuality}
                options={[
                  {
                    label: 'HD',
                    value: 'hd',
                    disabled: !availableFormats.includes('HD'),
                  },
                  ...(show4kAvailability
                    ? ([
                        {
                          label: '4K',
                          value: '4k',
                          disabled: !availableFormats.includes('4K'),
                        },
                      ] as const)
                    : []),
                ]}
                onChange={setSelectedQuality}
                label={intl.formatMessage(messages.quality)}
              />
              {playbackActions?.(
                effectivePlaybackItemIds,
                effectiveSelectedQuality === '4k'
              )}
              {playbackActions && (
                <PlayOnDeviceButton
                  mediaId={data.mediaInfo?.id}
                  itemIds={effectivePlaybackItemIds}
                  is4k={effectiveSelectedQuality === '4k'}
                />
              )}
              {effectiveRatings.rtCriticsRating !== undefined &&
                effectiveRatings.rtCriticsScore !== undefined && (
                  <Tooltip
                    content={intl.formatMessage(messages.rtCriticsScore)}
                  >
                    <a
                      href={getSafeHref(effectiveRatings.rtUrl)}
                      target="_blank"
                      rel="noreferrer"
                      className="media-rating-link"
                    >
                      {effectiveRatings.rtCriticsRating === 'Rotten' ? (
                        <RTRotten className="media-rating-icon" />
                      ) : (
                        <RTFresh className="media-rating-icon" />
                      )}
                      <span className="media-rating-value">
                        {effectiveRatings.rtCriticsScore}%
                      </span>
                    </a>
                  </Tooltip>
                )}
              {effectiveRatings.rtAudienceRating !== undefined &&
                effectiveRatings.rtAudienceScore !== undefined && (
                  <Tooltip
                    content={intl.formatMessage(messages.rtAudienceScore)}
                  >
                    <a
                      href={getSafeHref(effectiveRatings.rtUrl)}
                      target="_blank"
                      rel="noreferrer"
                      className="media-rating-link"
                    >
                      {effectiveRatings.rtAudienceRating === 'Spilled' ? (
                        <RTAudRotten className="media-rating-icon media-rating-icon-audience" />
                      ) : (
                        <RTAudFresh className="media-rating-icon media-rating-icon-audience" />
                      )}
                      <span className="media-rating-value">
                        {effectiveRatings.rtAudienceScore}%
                      </span>
                    </a>
                  </Tooltip>
                )}
              {effectiveRatings.imdbScore !== undefined && (
                <Tooltip
                  content={
                    effectiveRatings.imdbVotes
                      ? intl.formatMessage(messages.imdbUserScore, {
                          formattedCount: intl.formatNumber(
                            effectiveRatings.imdbVotes,
                            {
                              notation: 'compact',
                              compactDisplay: 'short',
                              maximumFractionDigits: 1,
                            }
                          ),
                        })
                      : intl.formatMessage(messages.imdbScore)
                  }
                >
                  <a
                    href={getSafeHref(effectiveRatings.imdbUrl)}
                    target="_blank"
                    rel="noreferrer"
                    className="media-rating-link"
                  >
                    <ImdbLogo className="media-rating-wordmark" />
                    <span className="media-rating-value">
                      {effectiveRatings.imdbScore.toFixed(1)}
                    </span>
                  </a>
                </Tooltip>
              )}
              <MdblistRatingBadges ratings={ratingData?.mdblist} />
              {data.voteCount > 0 && (
                <Tooltip content={intl.formatMessage(messages.tmdbUserScore)}>
                  <a
                    href={`https://www.themoviedb.org/tv/${data.id}?language=${locale}`}
                    target="_blank"
                    rel="noreferrer"
                    className="media-rating-link"
                  >
                    <TmdbLogo className="media-rating-wordmark" />
                    <span className="media-rating-value">
                      {Math.round(data.voteAverage * 10)}%
                    </span>
                  </a>
                </Tooltip>
              )}
            </div>
          )}

          <div className="media-primary-action-row">
            {primaryActions}
            {secondaryActions}
          </div>

          <section className="app-card-inset refreshed-inset-surface card-spacing-before rounded-lg border border-gray-700 p-3">
            <h2 className="media-inset-heading">
              {intl.formatMessage(messages.overview)}
            </h2>
            {data.tagline && (
              <p className="mt-1 text-sm text-indigo-300 italic">
                {data.tagline}
              </p>
            )}
            <p className="refreshed-detail-text-muted mt-4 text-sm leading-5">
              {data.overview ||
                intl.formatMessage(messages.overviewUnavailable)}
            </p>

            {featuredCrew.length > 0 && (
              <div className="detail-three-column-grid card:border-t-0 card:pt-0 mt-4 grid border-t border-gray-600 pt-3">
                {featuredCrewGroups.map((group, groupIndex) => (
                  <dl
                    key={`featured-crew-${groupIndex}`}
                    className={`media-detail-rows grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3 text-xs ${
                      groupIndex > 0
                        ? `media-detail-column-divider ${groupIndex === 1 ? 'card:pr-3' : ''}`
                        : 'card:pr-3'
                    }`}
                  >
                    {group.map((person) => (
                      <div
                        className="contents"
                        key={`${person.id}-${person.job}`}
                      >
                        <dt className="font-medium text-gray-100">
                          {person.job}:
                        </dt>
                        <dd className="m-0 truncate">
                          <Link
                            href={`/person/${person.id}`}
                            className="text-indigo-300 hover:text-indigo-200 hover:underline focus:ring-2 focus:ring-indigo-400 focus:outline-none"
                          >
                            {person.name}
                          </Link>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ))}
              </div>
            )}
          </section>

          <div className="media-detail-disclosure-row">
            <CollectionNavigation kind="tv" id={String(data.id)} />
            <DetailDisclosureButton
              label={intl.formatMessage(messages.viewCast)}
              open={showCast}
              onClick={() => setShowCast((open) => !open)}
              pinned={pins.cast}
              onPinClick={() => void togglePinned('cast')}
            />
            <DetailDisclosureButton
              label={intl.formatMessage(messages.viewCrew)}
              open={showCrew}
              onClick={() => setShowCrew((open) => !open)}
              pinned={pins.crew}
              onPinClick={() => void togglePinned('crew')}
            />
            <DetailDisclosureButton
              label={intl.formatMessage(messages.subjectTags)}
              open={showTags}
              onClick={() => setShowTags((open) => !open)}
              pinned={pins.subjectTags}
              onPinClick={() => void togglePinned('subjectTags')}
            />
            <DetailDisclosureButton
              label={intl.formatMessage(messages.seriesDetails)}
              open={showDetails}
              onClick={() => setShowDetails((open) => !open)}
              pinned={pins.details}
              onPinClick={() => void togglePinned('details')}
              controls="tv-additional-details"
            />
          </div>

          {showCast && (
            <ExpandableCreditList
              title={intl.formatMessage(messages.fullCastList)}
              credits={castCredits}
              emptyLabel={intl.formatMessage(messages.noCast)}
            />
          )}
          {showCrew && (
            <ExpandableCreditList
              title={intl.formatMessage(messages.fullCrewList)}
              credits={crewCredits}
              emptyLabel={intl.formatMessage(messages.noCrew)}
            />
          )}
          {showTags && (
            <section className="app-card-inset refreshed-inset-surface card-spacing-before rounded-lg border border-gray-700 p-3">
              <h2 className="media-inset-heading mb-2">
                {intl.formatMessage(messages.subjectTags)}
              </h2>
              {data.keywords.length === 0 ? (
                <p className="refreshed-detail-text-muted text-xs">
                  {intl.formatMessage(messages.noTags)}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {data.keywords.map((keyword, index) => (
                    <Link
                      key={keyword.id}
                      href={`/discover/tv/keyword?keywords=${keyword.id}`}
                      className={subjectTagClassName(index)}
                    >
                      {keyword.name}
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}

          {showDetails && (
            <section
              id="tv-additional-details"
              className="app-card-inset refreshed-inset-surface card-spacing-before rounded-lg border border-gray-700 p-3"
            >
              <h2 className="media-inset-heading detail-card-heading-after">
                {intl.formatMessage(messages.seriesDetails)}
              </h2>
              <div className="detail-three-column-grid grid">
                <dl className="media-detail-rows grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3 text-xs">
                  <dt className="font-medium text-gray-100">
                    {intl.formatMessage(messages.status)}:
                  </dt>
                  <dd className="m-0">{data.status || unavailable}</dd>
                  <dt className="font-medium text-gray-100">
                    {intl.formatMessage(messages.airDates)}:
                  </dt>
                  <dd className="m-0 min-w-0">
                    {airDates.length > 0
                      ? airDates.map((airDate) => (
                          <span className="block" key={airDate.label.id}>
                            {intl.formatMessage(airDate.label)} ·{' '}
                            {intl.formatDate(airDate.value, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                              timeZone: 'UTC',
                            })}
                          </span>
                        ))
                      : unavailable}
                  </dd>
                </dl>

                <dl className="media-detail-rows media-detail-column-divider card:pr-3 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3 text-xs">
                  <dt className="font-medium text-gray-100">
                    {intl.formatMessage(messages.seriesType)}:
                  </dt>
                  <dd className="m-0 truncate">{data.type || unavailable}</dd>
                  <dt className="font-medium text-gray-100">
                    {intl.formatMessage(messages.episodeRuntime)}:
                  </dt>
                  <dd className="m-0 truncate">
                    {data.episodeRunTime[0]
                      ? intl.formatMessage(messages.minutes, {
                          minutes: data.episodeRunTime[0],
                        })
                      : unavailable}
                  </dd>
                  <dt className="font-medium text-gray-100">
                    {intl.formatMessage(messages.language)}:
                  </dt>
                  <dd className="m-0 truncate">
                    <Link
                      href={`/discover/tv/language/${data.originalLanguage}`}
                      className="text-indigo-300 hover:text-indigo-200 hover:underline focus:ring-2 focus:ring-indigo-400 focus:outline-none"
                    >
                      {originalLanguage}
                    </Link>
                  </dd>
                  <dt className="font-medium text-gray-100">
                    {intl.formatMessage(messages.country)}:
                  </dt>
                  <dd className="m-0 min-w-0">
                    {data.productionCountries.length > 0
                      ? data.productionCountries.map((country, index) => (
                          <span key={country.iso_3166_1}>
                            {index > 0 && ', '}
                            <Link
                              href={`/discover/tv?country=${country.iso_3166_1}`}
                              className="text-indigo-300 hover:text-indigo-200 hover:underline focus:ring-2 focus:ring-indigo-400 focus:outline-none"
                            >
                              {intl.formatDisplayName(country.iso_3166_1, {
                                type: 'region',
                                fallback: 'none',
                              }) ?? country.name}
                            </Link>
                          </span>
                        ))
                      : unavailable}
                  </dd>
                </dl>

                <dl className="media-detail-rows media-detail-column-divider grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3 text-xs">
                  <dt className="font-medium text-gray-100">
                    {intl.formatMessage(messages.networks)}:
                  </dt>
                  <dd className="m-0 min-w-0">
                    {data.networks.length > 0
                      ? data.networks.slice(0, 4).map((network) => (
                          <Link
                            key={network.id}
                            href={`/discover/tv/network/${network.id}`}
                            className="block truncate text-indigo-300 hover:text-indigo-200 hover:underline focus:ring-2 focus:ring-indigo-400 focus:outline-none"
                          >
                            {network.name}
                          </Link>
                        ))
                      : unavailable}
                  </dd>
                </dl>
              </div>
            </section>
          )}
        </div>
      </article>

      <MediaSlider
        sliderKey="recommendations"
        title={intl.formatMessage(messages.recommendations)}
        url={`/api/v1/tv/${data.id}/recommendations`}
        linkUrl={`/tv/${data.id}/recommendations`}
        hideWhenEmpty
      />
      <MediaSlider
        sliderKey="similar"
        title={intl.formatMessage(messages.similar)}
        url={`/api/v1/tv/${data.id}/similar`}
        linkUrl={`/tv/${data.id}/similar`}
        hideWhenEmpty
      />
      <div className="extra-bottom-space relative" />
    </div>
  );
};

export default SeriesDetailsLayout;

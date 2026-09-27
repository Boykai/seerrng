import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import MediaServerIcon, {
  getMediaServerName,
} from '@app/components/Common/MediaServerIcon';
import SelectionCircle, {
  selectFromRow,
  selectFromRowKey,
} from '@app/components/Common/SelectionCircle';
import Tooltip from '@app/components/Common/Tooltip';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckCircleIcon,
  ServerStackIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { CheckIcon } from '@heroicons/react/24/solid';
import type { PlaybackCatalogResponse } from '@server/models/Playback';
import type { SeasonWithEpisodes, TvDetails } from '@server/models/Tv';
import type { WatchStatusResponse } from '@server/models/WatchStatus';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MediaDetails.SeriesBrowser', {
  season: 'Season',
  episodes: 'Episodes',
  episode: 'Episode',
  title: 'Title',
  specials: 'Specials',
  seasonNumber: 'Season {number}',
  episodeNumber: 'Episode {number}',
  untitled: 'Untitled',
  noSeasons: 'No Seasons Available',
  selectSeason: 'Select a season to view its episodes',
  loadError: 'Episodes could not be loaded. Try selecting the season again.',
  availabilityLegend:
    'Bright green check: fully available. Dark green check: partially available. Red X: not available.',
  selection: 'Select items to play',
  selectSeasonEpisodes: 'Select every available episode in this season',
  deselectSeasonEpisodes: 'Clear this season from the playback selection',
  watched: 'Watched',
  unwatched: 'Unwatched',
  unwatchedCount:
    '{count} unwatched {count, plural, one {episode} other {episodes}}',
});

interface SeriesSeasonEpisodeBrowserProps {
  tvId: number;
  seasons: TvDetails['seasons'];
  catalog?: PlaybackCatalogResponse;
  watchedStatus?: WatchStatusResponse;
  selectedItemIds: string[];
  onSelectionChange: (itemIds: string[]) => void;
}

const SeriesSeasonEpisodeBrowser = ({
  tvId,
  seasons,
  catalog,
  watchedStatus,
  selectedItemIds,
  onSelectionChange,
}: SeriesSeasonEpisodeBrowserProps) => {
  const intl = useIntl();
  const visibleSeasons = useMemo(
    () => seasons.filter((season) => season.episodeCount > 0),
    [seasons]
  );
  const [activeSeason, setActiveSeason] = useState(
    visibleSeasons.find((season) => season.seasonNumber > 0)?.seasonNumber ??
      visibleSeasons[0]?.seasonNumber ??
      -1
  );

  useEffect(() => {
    if (
      !visibleSeasons.some((season) => season.seasonNumber === activeSeason)
    ) {
      setActiveSeason(
        visibleSeasons.find((season) => season.seasonNumber > 0)
          ?.seasonNumber ??
          visibleSeasons[0]?.seasonNumber ??
          -1
      );
    }
  }, [activeSeason, visibleSeasons]);

  const { data, error } = useSWR<SeasonWithEpisodes>(
    activeSeason >= 0 ? `/api/v1/tv/${tvId}/season/${activeSeason}` : null
  );
  const selection = useMemo(() => new Set(selectedItemIds), [selectedItemIds]);
  const activeCatalogSeason = catalog?.groups.find(
    (season) => season.index === activeSeason
  );
  const allPlayableItemIds = useMemo(
    () =>
      catalog?.groups.flatMap((group) => group.items.map((item) => item.id)) ??
      [],
    [catalog]
  );
  const allSeriesSelected =
    allPlayableItemIds.length > 0 &&
    allPlayableItemIds.every((itemId) => selection.has(itemId));
  const activeItemIds = activeCatalogSeason?.items.map((item) => item.id) ?? [];
  const allActiveSelected =
    activeItemIds.length > 0 &&
    activeItemIds.every((itemId) => selection.has(itemId));
  const toggleItems = (itemIds: string[]) => {
    if (itemIds.length === 0) return;
    const allSelected = itemIds.every((itemId) => selection.has(itemId));
    const next = new Set(selection);
    itemIds.forEach((itemId) =>
      allSelected ? next.delete(itemId) : next.add(itemId)
    );
    onSelectionChange([...next]);
  };
  const toggleSeason = (seasonNumber: number) => {
    const group = catalog?.groups.find(
      (season) => season.index === seasonNumber
    );
    if (!group?.available || group.items.length === 0) {
      return;
    }
    const itemIds = group.items.map((item) => item.id);
    toggleItems(itemIds);
  };
  const toggleEpisode = (itemId: string) => {
    const next = new Set(selection);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
    onSelectionChange([...next]);
  };

  const AvailabilityHeading = () => (
    <Tooltip content={intl.formatMessage(messages.availabilityLegend)}>
      <span
        className="media-availability-cell"
        aria-label={intl.formatMessage(messages.availabilityLegend)}
      >
        <ServerStackIcon className="h-4 w-4" />
      </span>
    </Tooltip>
  );
  const AvailabilityIcon = ({
    available,
    partial = false,
  }: {
    available: boolean;
    partial?: boolean;
  }) => {
    const label = intl.formatMessage(
      available
        ? partial
          ? globalMessages.partiallyavailable
          : globalMessages.available
        : globalMessages.notavailable
    );
    return (
      <Tooltip content={label}>
        <span className="media-availability-cell" aria-label={label}>
          {available ? (
            <CheckCircleIcon
              className={`h-4 w-4 ${
                partial ? 'text-emerald-600' : 'text-green-400'
              }`}
              aria-hidden
            />
          ) : (
            <XCircleIcon className="h-4 w-4 text-red-400" aria-hidden />
          )}
        </span>
      </Tooltip>
    );
  };
  const WatchHeading = () =>
    watchedStatus && getMediaServerName(watchedStatus.serverType) ? (
      <Tooltip content={getMediaServerName(watchedStatus.serverType) ?? ''}>
        <span className="watched-status-cell">
          <MediaServerIcon
            mediaServerType={watchedStatus.serverType}
            className="watched-status-logo"
          />
        </span>
      </Tooltip>
    ) : (
      <span className="watched-status-cell" />
    );
  const WatchCell = ({
    watched,
    unwatchedCount,
    incompleteLibrary = false,
  }: {
    watched: boolean;
    unwatchedCount?: number;
    incompleteLibrary?: boolean;
  }) => {
    if (!watchedStatus) {
      return <span className="watched-status-cell" />;
    }
    if (watched && !unwatchedCount && !incompleteLibrary) {
      return (
        <Tooltip content={intl.formatMessage(messages.watched)}>
          <span className="watched-status-cell">
            <CheckIcon className="watched-status-icon" aria-hidden="true" />
          </span>
        </Tooltip>
      );
    }
    const label =
      incompleteLibrary && watched && !unwatchedCount
        ? 'All downloaded episodes watched; this season is partially available'
        : unwatchedCount && watched
          ? intl.formatMessage(messages.unwatchedCount, {
              count: unwatchedCount,
            })
          : intl.formatMessage(messages.unwatched);
    return (
      <Tooltip content={label}>
        <span className="watched-status-cell" aria-label={label}>
          {unwatchedCount && watched ? unwatchedCount : '–'}
        </span>
      </Tooltip>
    );
  };

  return (
    <div className="mt-[5px] grid min-w-0 gap-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
      <section className="app-card-inset refreshed-inset-surface min-w-[12rem] rounded-lg border border-gray-700 p-2">
        <div className="media-inset-table-heading media-scroll-grid-header request-divider-dark season-watch-grid grid items-center gap-x-2 border-b pb-2 pl-1">
          <SelectionCircle
            disabled={allPlayableItemIds.length === 0}
            onClick={() => toggleItems(allPlayableItemIds)}
            selected={allSeriesSelected}
            label={intl.formatMessage(messages.selection)}
          />
          <span className="text-left">
            {intl.formatMessage(messages.season)}
          </span>
          <span className="text-center">
            {intl.formatMessage(messages.episodes)}
          </span>
          <AvailabilityHeading />
          <WatchHeading />
        </div>
        <div
          className="scrollable-card -mr-2 max-h-[133px] space-y-0.5 overflow-y-auto pt-1 pr-2 pb-1"
          data-testid="season-list"
        >
          {visibleSeasons.length === 0 && (
            <p className="refreshed-detail-text-muted px-1 py-2 text-xs">
              {intl.formatMessage(messages.noSeasons)}
            </p>
          )}
          {visibleSeasons.map((season) => {
            const group = catalog?.groups.find(
              (candidate) => candidate.index === season.seasonNumber
            );
            const availableEpisodeCount = group?.items.length ?? 0;
            const available = availableEpisodeCount > 0;
            const partiallyAvailable =
              availableEpisodeCount > 0 &&
              availableEpisodeCount < season.episodeCount;
            const selectedCount =
              group?.items.filter((item) => selection.has(item.id)).length ?? 0;
            const allSelected =
              !!group?.items.length && selectedCount === group.items.length;
            const partiallySelected = selectedCount > 0 && !allSelected;
            const watchSeason = watchedStatus?.seasons?.find(
              (item) => item.seasonNumber === season.seasonNumber
            );
            return (
              <div
                key={season.seasonNumber}
                className={`selectable-table-row season-focus-row season-watch-grid grid w-full items-center gap-x-2 rounded px-1 py-1 ${
                  activeSeason === season.seasonNumber ? 'bg-indigo-500/15' : ''
                }`}
                data-active={activeSeason === season.seasonNumber}
                data-selectable="true"
                role="button"
                tabIndex={0}
                aria-label={`Season ${season.seasonNumber}`}
                onClick={(event) => {
                  selectFromRow(event, () => {
                    setActiveSeason(season.seasonNumber);
                    if (available) toggleSeason(season.seasonNumber);
                  });
                }}
                onKeyDown={(event) => {
                  selectFromRowKey(event, () => {
                    setActiveSeason(season.seasonNumber);
                    if (available) toggleSeason(season.seasonNumber);
                  });
                }}
              >
                <SelectionCircle
                  disabled={!available}
                  onClick={() => {
                    setActiveSeason(season.seasonNumber);
                    toggleSeason(season.seasonNumber);
                  }}
                  selected={allSelected}
                  partial={partiallySelected}
                  label={intl.formatMessage(
                    allSelected
                      ? messages.deselectSeasonEpisodes
                      : messages.selectSeasonEpisodes
                  )}
                />
                <span className="truncate text-left text-xs font-medium text-gray-100">
                  {season.seasonNumber === 0
                    ? intl.formatMessage(messages.specials)
                    : intl.formatMessage(messages.seasonNumber, {
                        number: season.seasonNumber,
                      })}
                </span>
                <span className="refreshed-detail-text text-center text-xs">
                  {season.episodeCount}
                </span>
                <AvailabilityIcon
                  available={available}
                  partial={partiallyAvailable}
                />
                <WatchCell
                  watched={Boolean(watchSeason?.watchedCount)}
                  incompleteLibrary={
                    Boolean(watchSeason?.availableCount) &&
                    (watchSeason?.availableCount ?? 0) < season.episodeCount
                  }
                  unwatchedCount={
                    watchSeason
                      ? watchSeason.availableCount - watchSeason.watchedCount
                      : undefined
                  }
                />
              </div>
            );
          })}
        </div>
      </section>

      <section className="app-card-inset refreshed-inset-surface min-w-0 rounded-lg border border-gray-700 p-2">
        <div className="media-inset-table-heading media-scroll-grid-header request-divider-dark episode-watch-grid grid items-center gap-x-2 border-b pb-2 pl-1">
          <SelectionCircle
            disabled={activeItemIds.length === 0}
            onClick={() => toggleItems(activeItemIds)}
            selected={allActiveSelected}
            label={intl.formatMessage(messages.selection)}
          />
          <span className="text-left">
            {intl.formatMessage(messages.episode)}
          </span>
          <span className="text-left">
            {intl.formatMessage(messages.title)}
          </span>
          <AvailabilityHeading />
          <WatchHeading />
        </div>
        <div
          className="scrollable-card -mr-2 max-h-[133px] space-y-0.5 overflow-y-auto pt-1 pr-2"
          data-testid="episode-list"
        >
          {!data && !error && activeSeason >= 0 && (
            <div className="flex h-20 items-center justify-center">
              <LoadingSpinner />
            </div>
          )}
          {activeSeason < 0 && (
            <p className="refreshed-detail-text-muted px-1 py-2 text-xs">
              {intl.formatMessage(messages.selectSeason)}
            </p>
          )}
          {error && (
            <p className="px-1 py-2 text-xs text-red-300">
              {intl.formatMessage(messages.loadError)}
            </p>
          )}
          {data?.episodes.map((episode) => {
            const playableItem = activeCatalogSeason?.items.find(
              (item) => item.index === episode.episodeNumber
            );
            const available = !!playableItem;
            const selected = playableItem
              ? selection.has(playableItem.id)
              : false;
            const watchEpisode = watchedStatus?.seasons
              ?.find((season) => season.seasonNumber === activeSeason)
              ?.episodes.find(
                (item) => item.episodeNumber === episode.episodeNumber
              );
            return (
              <div
                key={episode.id}
                className="selectable-table-row episode-watch-grid grid w-full items-center gap-x-2 rounded px-1 py-1"
                data-selectable={available}
                role={available ? 'button' : undefined}
                tabIndex={available ? 0 : undefined}
                aria-label={`Select episode ${episode.episodeNumber}`}
                onClick={(event) => {
                  if (playableItem)
                    selectFromRow(event, () => toggleEpisode(playableItem.id));
                }}
                onKeyDown={(event) => {
                  if (playableItem)
                    selectFromRowKey(event, () =>
                      toggleEpisode(playableItem.id)
                    );
                }}
              >
                <SelectionCircle
                  disabled={!playableItem}
                  onClick={() => playableItem && toggleEpisode(playableItem.id)}
                  selected={selected}
                  label={intl.formatMessage(messages.selection)}
                />
                <span className="text-xs font-medium text-gray-100">
                  {intl.formatMessage(messages.episodeNumber, {
                    number: episode.episodeNumber,
                  })}
                </span>
                <span className="refreshed-detail-text truncate text-xs">
                  {episode.name || intl.formatMessage(messages.untitled)}
                </span>
                <AvailabilityIcon available={available} />
                <WatchCell watched={watchEpisode?.watched === true} />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};

export default SeriesSeasonEpisodeBrowser;

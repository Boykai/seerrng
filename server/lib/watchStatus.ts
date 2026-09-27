import type { MediaServerType } from '@server/constants/server';
import type {
  WatchEpisodeStatus,
  WatchStatusResponse,
} from '@server/models/WatchStatus';

export const getMovieWatchStatus = (
  serverType: MediaServerType,
  watched: boolean
): WatchStatusResponse => ({
  serverType,
  availableCount: 1,
  watchedCount: watched ? 1 : 0,
  unwatchedCount: watched ? 0 : 1,
});

export const getSeriesWatchStatus = (
  serverType: MediaServerType,
  episodes: WatchEpisodeStatus[],
  includeEpisodes = false
): WatchStatusResponse => {
  const uniqueEpisodes = new Map<string, WatchEpisodeStatus>();
  for (const episode of episodes) {
    if (
      !Number.isSafeInteger(episode.seasonNumber) ||
      !Number.isSafeInteger(episode.episodeNumber) ||
      episode.seasonNumber < 0 ||
      episode.episodeNumber < 0
    ) {
      continue;
    }
    const key = `${episode.seasonNumber}:${episode.episodeNumber}`;
    const previous = uniqueEpisodes.get(key);
    uniqueEpisodes.set(key, {
      ...episode,
      watched: episode.watched || previous?.watched === true,
    });
  }

  const grouped = new Map<number, WatchEpisodeStatus[]>();
  for (const episode of uniqueEpisodes.values()) {
    const season = grouped.get(episode.seasonNumber) ?? [];
    season.push(episode);
    grouped.set(episode.seasonNumber, season);
  }
  const seasons = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([seasonNumber, items]) => {
      const sorted = items.sort(
        (left, right) => left.episodeNumber - right.episodeNumber
      );
      return {
        seasonNumber,
        availableCount: sorted.length,
        watchedCount: sorted.filter((episode) => episode.watched).length,
        episodes: sorted,
      };
    });
  const availableCount = uniqueEpisodes.size;
  const watchedCount = seasons.reduce(
    (sum, season) => sum + season.watchedCount,
    0
  );
  return {
    serverType,
    availableCount,
    watchedCount,
    unwatchedCount: availableCount - watchedCount,
    ...(includeEpisodes ? { seasons } : {}),
  };
};

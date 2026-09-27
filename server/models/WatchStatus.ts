import type { MediaServerType } from '@server/constants/server';

export interface WatchEpisodeStatus {
  seasonNumber: number;
  episodeNumber: number;
  watched: boolean;
}

export interface WatchSeasonStatus {
  seasonNumber: number;
  availableCount: number;
  watchedCount: number;
  episodes: WatchEpisodeStatus[];
}

export interface WatchStatusResponse {
  serverType: MediaServerType;
  availableCount: number;
  watchedCount: number;
  unwatchedCount: number;
  seasons?: WatchSeasonStatus[];
}

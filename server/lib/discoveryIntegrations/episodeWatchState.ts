import type { SimklWatchedEpisodeLookup } from '@server/api/simkl';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type { DiscoveryAccountProvider } from '@server/entity/DiscoveryAccount';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import { getSettings, MetadataProviderType } from '@server/lib/settings';
import {
  DiscoveryIntegrationError,
  getSimklClient,
  getTraktClient,
  requireDiscoveryAccount,
} from './accounts';
import { cachedAccountRead } from './cache';

type TrackingProvider = Extract<DiscoveryAccountProvider, 'trakt' | 'simkl'>;

export interface ProviderEpisodeWatchState {
  available: boolean;
  season: number;
  episodes: { episode: number; watched: boolean }[];
}

export interface EpisodeWatchStateRequest {
  sourceId: string;
  tmdbId: number;
  season: number;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const positive = (value: unknown): number | undefined => {
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) &&
    Number(number) > 0 &&
    Number(number) <= 2147483647
    ? Number(number)
    : undefined;
};

const coordinate = (value: unknown): number | undefined => {
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) &&
    Number(number) >= 0 &&
    Number(number) <= 10000
    ? Number(number)
    : undefined;
};

function date(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 64) return;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function traktSeasonState(
  value: unknown,
  seasonNumber: number
): ProviderEpisodeWatchState {
  const progress = record(value);
  const seasons = Array.isArray(progress.seasons) ? progress.seasons : [];
  const season = seasons.find(
    (candidate) => coordinate(record(candidate).number) === seasonNumber
  );
  const resetAt = date(progress.reset_at);
  const episodes = Array.isArray(record(season).episodes)
    ? (record(season).episodes as unknown[])
        .map((raw) => {
          const episode = record(raw);
          const number = positive(episode.number);
          if (!number) return undefined;
          const lastWatchedAt = date(episode.last_watched_at);
          const wasWatched =
            episode.completed === true || Number(episode.plays) > 0;
          const watched =
            resetAt === undefined
              ? wasWatched
              : wasWatched &&
                lastWatchedAt !== undefined &&
                lastWatchedAt >= resetAt;
          return { episode: number, watched };
        })
        .filter((episode): episode is { episode: number; watched: boolean } =>
          Boolean(episode)
        )
    : [];
  return {
    available: episodes.length > 0,
    season: seasonNumber,
    episodes,
  };
}

export function parseSimklSeasonWatchState(
  value: unknown,
  seasonNumber: number
): ProviderEpisodeWatchState {
  const rows = Array.isArray(value) ? value : [];
  const row = record(rows[0]);
  const seasons = Array.isArray(row.seasons) ? row.seasons : [];
  const season = seasons.find(
    (candidate) => coordinate(record(candidate).number) === seasonNumber
  );
  const episodes = Array.isArray(record(season).episodes)
    ? (record(season).episodes as unknown[])
        .map((raw) => {
          const episode = record(raw);
          const number = positive(episode.number);
          if (!number || typeof episode.watched !== 'boolean') return undefined;
          return { episode: number, watched: episode.watched };
        })
        .filter((episode): episode is { episode: number; watched: boolean } =>
          Boolean(episode)
        )
    : [];
  return {
    available: episodes.length > 0,
    season: seasonNumber,
    episodes,
  };
}

export function simklWatchedEpisodeLookup(
  sourceId: string,
  isAnime: boolean,
  tvdbId: number | undefined,
  metadataProvider: MetadataProviderType
): SimklWatchedEpisodeLookup {
  return isAnime &&
    tvdbId !== undefined &&
    metadataProvider === MetadataProviderType.TVDB
    ? { tvdb: tvdbId }
    : { simkl: Number(sourceId) };
}

export function parseEpisodeWatchStateRequest(
  value: unknown
): EpisodeWatchStateRequest {
  const body = record(value);
  if (
    Object.keys(body).some(
      (key) => !['sourceId', 'tmdbId', 'season'].includes(key)
    ) ||
    typeof body.sourceId !== 'string' ||
    !/^[1-9]\d{0,9}$/.test(body.sourceId) ||
    !positive(body.sourceId) ||
    !positive(body.tmdbId) ||
    coordinate(body.season) === undefined
  )
    throw new DiscoveryIntegrationError(
      400,
      'Choose a valid provider title and episode season.'
    );
  if (!isMediaCategoryEnabled('tv'))
    throw new DiscoveryIntegrationError(403, 'Series tracking is disabled.');
  return {
    sourceId: body.sourceId,
    tmdbId: Number(body.tmdbId),
    season: Number(body.season),
  };
}

export async function providerEpisodeWatchState(
  userId: number,
  provider: TrackingProvider,
  request: EpisodeWatchStateRequest
): Promise<ProviderEpisodeWatchState> {
  if (provider === 'trakt') {
    const api = await getTraktClient(userId);
    await api.prepareAccessToken();
    const account = await requireDiscoveryAccount(userId, provider);
    const progress = await cachedAccountRead(
      account,
      'episodes:trakt:' + request.sourceId,
      () => api.getShowWatchedProgress(Number(request.sourceId))
    );
    return traktSeasonState(progress, request.season);
  }

  const account = await requireDiscoveryAccount(userId, provider);
  const api = await getSimklClient(userId);
  const settings = getSettings();
  const queryKey =
    'episodes:simkl:' +
    request.sourceId +
    ':' +
    request.tmdbId +
    ':' +
    settings.metadataSettings.anime +
    ':' +
    settings.metadataSettings.tv;
  const watched = await cachedAccountRead(account, queryKey, async () => {
    let details: Awaited<ReturnType<TheMovieDb['getTvShow']>>;
    try {
      details = await new TheMovieDb().getTvShow({ tvId: request.tmdbId });
    } catch {
      throw new DiscoveryIntegrationError(
        502,
        'The series identity could not be confirmed. Try again.'
      );
    }
    if (details.id !== request.tmdbId)
      throw new DiscoveryIntegrationError(
        409,
        'The series identity changed. Refresh the library and try again.'
      );

    const isAnime = details.keywords.results.some(
      (keyword) => keyword.id === ANIME_KEYWORD_ID
    );
    const metadataProvider = isAnime
      ? settings.metadataSettings.anime
      : settings.metadataSettings.tv;
    const tvdbId = positive(details.external_ids?.tvdb_id);
    const item = simklWatchedEpisodeLookup(
      request.sourceId,
      isAnime,
      tvdbId,
      metadataProvider
    );
    return api.getWatchedEpisodes([item]);
  });
  return parseSimklSeasonWatchState(watched, request.season);
}

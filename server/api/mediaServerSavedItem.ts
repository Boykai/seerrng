import ExternalAPI from '@server/api/externalapi';
import { PLEXTV_HTTP_OPTIONS, parsePlexDevices } from '@server/api/plextv';
import { mapWithConcurrency } from '@server/utils/concurrency';
import { isAxiosError } from 'axios';
import { parseStringPromise } from 'xml2js';
export {
  FavoriteSeriesAPI,
  validSavedItemId,
} from '@server/api/jellyfinEmbySavedItems';

const DISCOVER = 'https://discover.provider.plex.tv';
const METADATA = 'https://metadata.provider.plex.tv';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const WATCHLIST_PHASES = [
  'series-metadata',
  'account',
  'catalog-search',
  'catalog-identity',
  'watchlist-state',
  'watchlist-write',
  'watchlist-confirmation',
] as const;
const WATCHLIST_FAILURE_CATEGORIES = [
  'http',
  'transport',
  'invalid-response',
  'identity-mismatch',
  'confirmation-mismatch',
  'unexpected',
] as const;
type WatchlistPhase = (typeof WATCHLIST_PHASES)[number];
type WatchlistFailureCategory = (typeof WATCHLIST_FAILURE_CATEGORIES)[number];
export interface PlexWatchlistDiagnostic {
  phase: WatchlistPhase;
  category: WatchlistFailureCategory;
  upstreamStatus?: number;
}

// Store only allowlisted diagnostics. Never retain a provider error/cause,
// response body, URL, request configuration, token, or account/media identity.
export class PlexWatchlistError extends Error {
  public readonly diagnostic: Readonly<PlexWatchlistDiagnostic>;

  constructor(
    phase: WatchlistPhase,
    category: WatchlistFailureCategory,
    upstreamStatus?: number
  ) {
    super('Plex Watchlist operation failed.');
    this.name = 'PlexWatchlistError';
    this.diagnostic = Object.freeze({
      phase,
      category,
      ...(category === 'http' &&
      Number.isInteger(upstreamStatus) &&
      upstreamStatus! >= 400 &&
      upstreamStatus! <= 599
        ? { upstreamStatus }
        : {}),
    });
  }
}

export const getPlexWatchlistDiagnostic = (
  error: unknown
): PlexWatchlistDiagnostic | undefined => {
  if (!(error instanceof PlexWatchlistError)) return undefined;
  const { phase, category, upstreamStatus } = error.diagnostic;
  if (
    !WATCHLIST_PHASES.includes(phase) ||
    !WATCHLIST_FAILURE_CATEGORIES.includes(category)
  )
    return undefined;
  // Copy only known fields even if the error was extended by another caller.
  return {
    phase,
    category,
    ...(category === 'http' &&
    Number.isInteger(upstreamStatus) &&
    upstreamStatus! >= 400 &&
    upstreamStatus! <= 599
      ? { upstreamStatus }
      : {}),
  };
};

export const runPlexWatchlistPhase = async <T>(
  phase: WatchlistPhase,
  operation: () => Promise<T>
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (getPlexWatchlistDiagnostic(error)) throw error;
    if (isAxiosError(error)) {
      const status = error.response?.status;
      throw new PlexWatchlistError(
        phase,
        Number.isInteger(status) && status! >= 400 && status! <= 599
          ? 'http'
          : 'transport',
        status
      );
    }
    throw new PlexWatchlistError(phase, 'unexpected');
  }
};

export const plexShowCatalogId = (guid: unknown): string | undefined =>
  typeof guid === 'string'
    ? /^plex:\/\/show\/([a-f\d]{24})$/i.exec(guid)?.[1]
    : undefined;

export const exactPlexSeries = (
  value: unknown,
  tmdbId: number
): string | undefined => {
  if (!isRecord(value) || value.type !== 'show') return undefined;
  const catalogId = plexShowCatalogId(value.guid);
  return catalogId &&
    Array.isArray(value.Guid) &&
    value.Guid.length <= 100 &&
    value.Guid.some((guid) => isRecord(guid) && guid.id === `tmdb://${tmdbId}`)
    ? catalogId
    : undefined;
};

export const parsePlexSavedState = (
  value: unknown,
  phase: 'watchlist-state' | 'watchlist-confirmation' = 'watchlist-state'
): boolean => {
  const container =
    isRecord(value) && isRecord(value.MediaContainer)
      ? value.MediaContainer
      : undefined;
  const state = Array.isArray(container?.UserState)
    ? container.UserState.length === 1
      ? container.UserState[0]
      : undefined
    : container?.UserState;
  if (!isRecord(state)) throw new PlexWatchlistError(phase, 'invalid-response');
  const timestamp = state.watchlistedAt;
  if (
    timestamp === undefined ||
    timestamp === null ||
    timestamp === 0 ||
    timestamp === '0'
  )
    return false;
  if (
    (typeof timestamp !== 'number' && typeof timestamp !== 'string') ||
    !/^\d{1,15}$/.test(String(timestamp))
  )
    throw new PlexWatchlistError(phase, 'invalid-response');
  return Number(timestamp) > 0;
};

/** Plex's account-level Universal Watchlist, not PMS queues or Seerr's list. */
export class PlexSavedItemAPI extends ExternalAPI {
  constructor(token: string) {
    super(
      'https://plex.tv',
      {},
      {
        ...PLEXTV_HTTP_OPTIONS,
        allowedBaseUrls: [DISCOVER, METADATA],
        headers: { 'X-Plex-Token': token, Accept: 'application/json' },
      }
    );
  }

  public async verifyAccount(plexId: number): Promise<void> {
    return runPlexWatchlistPhase('account', async () => {
      const { data } = await this.request<unknown>(
        'GET',
        '/users/account.json'
      );
      if (!isRecord(data) || !isRecord(data.user))
        throw new PlexWatchlistError('account', 'invalid-response');
      if (Number(data.user.id) !== plexId)
        throw new PlexWatchlistError('account', 'identity-mismatch');
    });
  }

  public async getOwnedServerIds(): Promise<string[]> {
    // Reuse the bounded resources parser without legacy error logging/cache.
    // Provider errors can contain account tokens; the route sanitizes failures.
    const { data } = await this.request<string>(
      'GET',
      '/api/resources?includeHttps=1',
      undefined,
      { transformResponse: [], responseType: 'text' }
    );
    const devices = parsePlexDevices(await parseStringPromise(data));
    return devices
      .filter((device) => device.owned && device.provides.includes('server'))
      .map((device) => device.clientIdentifier);
  }

  public async resolveSeries(
    tmdbId: number,
    title: string
  ): Promise<string | undefined> {
    const data = await runPlexWatchlistPhase('catalog-search', async () => {
      const response = await this.request<unknown>(
        'GET',
        '/library/search',
        undefined,
        {
          baseURL: DISCOVER,
          params: {
            query: title.slice(0, 512),
            limit: 30,
            searchTypes: 'tv',
            searchProviders: 'discover',
            includeMetadata: 1,
          },
        }
      );
      return response.data;
    });
    if (
      !isRecord(data) ||
      !isRecord(data.MediaContainer) ||
      !Array.isArray(data.MediaContainer.SearchResults)
    ) {
      throw new PlexWatchlistError('catalog-search', 'invalid-response');
    }
    const external = data.MediaContainer.SearchResults.find(
      (group) => isRecord(group) && group.id === 'external'
    );
    if (!external) return undefined;
    if (
      !isRecord(external) ||
      !Array.isArray(external.SearchResult) ||
      external.SearchResult.length > 30
    ) {
      throw new PlexWatchlistError('catalog-search', 'invalid-response');
    }
    const candidates = [
      ...new Set(
        external.SearchResult.flatMap((result) => {
          const metadata = isRecord(result) ? result.Metadata : undefined;
          const id =
            isRecord(metadata) && metadata.type === 'show'
              ? plexShowCatalogId(metadata.guid)
              : undefined;
          return id ? [id] : [];
        })
      ),
    ];
    const matches = await mapWithConcurrency(candidates, 5, async (id) => {
      const metadata = await runPlexWatchlistPhase(
        'catalog-identity',
        async () => {
          const response = await this.request<unknown>(
            'GET',
            `/library/metadata/${id}`,
            undefined,
            { baseURL: METADATA, params: { includeGuids: 1 } }
          );
          return response.data;
        }
      );
      if (
        !isRecord(metadata) ||
        !isRecord(metadata.MediaContainer) ||
        !Array.isArray(metadata.MediaContainer.Metadata) ||
        metadata.MediaContainer.Metadata.length !== 1
      ) {
        throw new PlexWatchlistError('catalog-identity', 'invalid-response');
      }
      const matched = exactPlexSeries(
        metadata.MediaContainer.Metadata[0],
        tmdbId
      );
      return matched === id ? matched : undefined;
    });
    const exact = matches.filter((id): id is string => !!id);
    if (exact.length > 1)
      throw new PlexWatchlistError('catalog-identity', 'identity-mismatch');
    return exact[0];
  }

  public async getSaved(
    id: string,
    phase: 'watchlist-state' | 'watchlist-confirmation' = 'watchlist-state'
  ): Promise<boolean> {
    if (!plexShowCatalogId(`plex://show/${id}`))
      throw new Error('Invalid Plex catalog ID.');
    return runPlexWatchlistPhase(phase, async () => {
      const { data } = await this.request<unknown>(
        'GET',
        `/library/metadata/${id}/userState`,
        undefined,
        { baseURL: METADATA }
      );
      return parsePlexSavedState(data, phase);
    });
  }

  public async setSaved(id: string, saved: boolean): Promise<void> {
    if (!plexShowCatalogId(`plex://show/${id}`))
      throw new Error('Invalid Plex catalog ID.');
    // Contract advertised by Discover / and exercised by python-plexapi MyPlexAccount.
    // A cloud Plex show GUID suffix is required; never a local PMS ratingKey.
    await runPlexWatchlistPhase('watchlist-write', async () => {
      await this.request(
        'PUT',
        `/actions/${saved ? 'addToWatchlist' : 'removeFromWatchlist'}`,
        undefined,
        { baseURL: DISCOVER, params: { ratingKey: id } }
      );
    });
  }
}

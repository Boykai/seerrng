// Adapted from selmant/foreseerr, copyright (c) 2026 Selman Trabzon. MIT licensed.
// See NOTICE.md for attribution and license terms.
import ExternalAPI from '@server/api/externalapi';
import type {
  SimklActivities,
  SimklPinCodeResponse,
  SimklPinTokenResponse,
  SimklSyncResponse,
  SimklUserSettingsResponse,
} from '@server/api/simkl/interfaces';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import { getAppVersion } from '@server/utils/appVersion';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import axios, { type AxiosInstance } from 'axios';
import { createHash } from 'node:crypto';

const SIMKL_BASE_URL = 'https://api.simkl.com';
const simklRequestSlots = new Map<string, number>();

export class SimklNotConfiguredError extends Error {
  constructor() {
    super('Simkl application Client ID is not configured');
    this.name = 'SimklNotConfiguredError';
  }
}

export class SimklNotLinkedError extends Error {
  constructor() {
    super('User has not linked a Simkl account');
    this.name = 'SimklNotLinkedError';
  }
}

export class SimklRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds = 1) {
    super(`Simkl API rate limited; retry after ${retryAfterSeconds}s`);
    this.name = 'SimklRateLimitedError';
  }
}

export class SimklUnauthorizedError extends Error {
  constructor() {
    super('Simkl authorization was rejected; reconnect the linked account');
    this.name = 'SimklUnauthorizedError';
  }
}

export class SimklTemporarilyUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Simkl is temporarily unavailable');
    this.name = 'SimklTemporarilyUnavailableError';
    this.cause = cause;
  }
}

type SimklOptions = {
  clientId?: string;
  accessToken?: string;
  onUnauthorized?: () => Promise<void>;
};

/** Small client deliberately serializes calls: Simkl limits uncached reads to 10/s. */
export default class SimklAPI extends ExternalAPI {
  private readonly clientId: string;
  private readonly rawAxios: AxiosInstance;
  private readonly onUnauthorized?: () => Promise<void>;
  private unauthorizedHandled = false;

  constructor(options: SimklOptions = {}) {
    const clientId = (
      options.clientId ?? getSettings().discoveryIntegrations.simkl.clientId
    ).trim();
    if (!clientId) throw new SimklNotConfiguredError();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'simkl-api-key': clientId,
      'app-name': 'seerrng',
      'app-version': getAppVersion(),
      'User-Agent': `SeerrNG/${getAppVersion()} (Simkl integration)`,
    };
    if (options.accessToken)
      headers.Authorization = `Bearer ${options.accessToken}`;
    super(
      SIMKL_BASE_URL,
      {},
      { headers, nodeCache: cacheManager.getCache('simkl').data }
    );
    this.clientId = clientId;
    this.onUnauthorized = options.onUnauthorized;
    this.rawAxios = axios.create({
      maxRedirects: 0,
      maxContentLength: 8 * 1024 * 1024,
      maxBodyLength: 1024 * 1024,
      baseURL: SIMKL_BASE_URL,
      timeout: getSettings().network.apiRequestTimeout,
      headers,
    });
    this.rawAxios.interceptors.request.use(proxyRequestInterceptor);
  }

  private async pace(post = false): Promise<void> {
    const interval = post ? 1000 : 100;
    const key = createHash('sha256').update(this.clientId).digest('hex');
    const now = Date.now();
    for (const [slot, expires] of simklRequestSlots)
      if (expires <= now) simklRequestSlots.delete(slot);
    const scheduled = Math.max(now, simklRequestSlots.get(key) ?? now);
    if (
      scheduled - now > 30_000 ||
      (simklRequestSlots.size >= 1024 && !simklRequestSlots.has(key))
    ) {
      throw new SimklRateLimitedError(30);
    }
    // Reserve before waiting so concurrent calls and client instances share one application budget.
    simklRequestSlots.set(key, scheduled + interval);
    if (scheduled > now)
      await new Promise((resolve) => setTimeout(resolve, scheduled - now));
  }

  private async simklRequest<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown
  ): Promise<T> {
    const cacheable = method === 'get' && !path.startsWith('/oauth/');
    if (cacheable) {
      const cached = this.getCached<T>(path);
      if (cached !== undefined) return cached;
    }
    await this.pace(method === 'post');
    const separator = path.includes('?') ? '&' : '?';
    const requiredParameters = new URLSearchParams({
      client_id: this.clientId,
      'app-name': 'seerrng',
      'app-version': getAppVersion(),
    });
    const requestPath = `${path}${separator}${requiredParameters}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const response =
          method === 'get'
            ? await this.rawAxios.get<T>(requestPath)
            : await this.rawAxios.post<T>(requestPath, body);
        if (cacheable) this.setCached(path, response.data, 300);
        if (method === 'post' && path.startsWith('/sync/'))
          this.removeCacheByEndpointPrefix('/sync/');
        return response.data;
      } catch (error) {
        const status = axios.isAxiosError(error)
          ? error.response?.status
          : undefined;
        if (status === 401) {
          if (this.onUnauthorized && !this.unauthorizedHandled) {
            this.unauthorizedHandled = true;
            await this.onUnauthorized();
          }
          throw new SimklUnauthorizedError();
        }
        if (status === 429) {
          const retryAfter =
            Number(error.response?.headers['retry-after']) || 1;
          throw new SimklRateLimitedError(Math.max(1, retryAfter));
        }
        // GET requests may safely retry once after a network or temporary
        // upstream failure. Mutating requests are deliberately never retried.
        if (method === 'get' && attempt === 0 && (!status || status >= 500)) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (!status || status >= 500)
          throw new SimklTemporarilyUnavailableError(error);
        throw error;
      }
    }
  }

  /** Requires a real Client ID; `/movies/trending` succeeds without one. */
  public async validateClientId(): Promise<void> {
    await this.getCdnCatalog('/discover/trending/tv/week_100.json');
  }

  public async requestPinCode(): Promise<SimklPinCodeResponse> {
    return this.simklRequest('get', '/oauth/pin');
  }

  public async pollPinToken(userCode: string): Promise<SimklPinTokenResponse> {
    return this.simklRequest(
      'get',
      `/oauth/pin/${encodeURIComponent(userCode)}`
    );
  }

  public async getUserSettings(): Promise<SimklUserSettingsResponse> {
    return this.simklRequest('post', '/users/settings', {});
  }

  public async getActivities(): Promise<SimklActivities> {
    return this.simklRequest('get', '/sync/activities');
  }

  public async getAllItems(
    type?: 'shows' | 'movies' | 'anime',
    params: Record<string, string | number | boolean> = {}
  ): Promise<SimklSyncResponse> {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    );
    return this.simklRequest(
      'get',
      `/sync/all-items${type ? `/${type}` : ''}${query.size ? `?${query}` : ''}`
    );
  }

  public async addHistory(
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<unknown> {
    return this.simklRequest('post', '/sync/history', {
      [mediaType === 'movie' ? 'movies' : 'shows']: [{ ids: { tmdb: tmdbId } }],
    });
  }

  public async removeHistory(
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<unknown> {
    return this.simklRequest('post', '/sync/history/remove', {
      [mediaType === 'movie' ? 'movies' : 'shows']: [{ ids: { tmdb: tmdbId } }],
    });
  }

  public async setRating(
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    rating: number
  ): Promise<unknown> {
    return this.simklRequest('post', '/sync/ratings', {
      [mediaType === 'movie' ? 'movies' : 'shows']: [
        { ids: { tmdb: tmdbId }, rating },
      ],
    });
  }

  public async removeRating(
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<unknown> {
    return this.simklRequest('post', '/sync/ratings/remove', {
      [mediaType === 'movie' ? 'movies' : 'shows']: [{ ids: { tmdb: tmdbId } }],
    });
  }

  public async getCatalog(
    path: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<unknown> {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    );
    return this.simklRequest('get', `${path}${query.size ? `?${query}` : ''}`);
  }

  public async getTitle(
    kind: 'movies' | 'tv' | 'anime',
    simklId: string
  ): Promise<Record<string, unknown>> {
    const payload = await this.simklRequest<unknown>(
      'get',
      `/${kind}/${encodeURIComponent(simklId)}`
    );
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  }

  public async getCdnCatalog(path: string): Promise<unknown> {
    await this.pace(false);
    const requiredParameters = new URLSearchParams({
      client_id: this.clientId,
      'app-name': 'seerrng',
      'app-version': getAppVersion(),
    });
    const url = `https://data.simkl.in${path}?${requiredParameters}`;
    try {
      const response = await this.rawAxios.get<unknown>(url);
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      if (status === 429) {
        const retryAfter = Number(error.response?.headers['retry-after']) || 1;
        throw new SimklRateLimitedError(Math.max(1, retryAfter));
      }
      throw new SimklTemporarilyUnavailableError(error);
    }
  }

  public async getWatchedEpisodes(): Promise<Record<string, unknown>> {
    return this.simklRequest('get', '/sync/watched?extended=episodes');
  }

  /**
   * `GET /redirect?to=simkl&<source>=<id>` answers `301` with the Simkl URL, so
   * the redirect must not be followed. Unlike the detail endpoint this one is
   * `cache-control: no-store`, hence its own budget class.
   */
  public async redirectToSimklId(
    source: 'anidb' | 'anilist' | 'mal' | 'kitsu' | 'imdb' | 'tvdb' | 'tmdb',
    externalId: string
  ): Promise<{ simklId: string; kind: 'anime' | 'tv' | 'movies' } | undefined> {
    await this.pace(false);
    const query = new URLSearchParams({
      to: 'simkl',
      [source]: externalId,
      client_id: this.clientId,
      'app-name': 'seerrng',
      'app-version': getAppVersion(),
    });
    const response = await this.rawAxios.get(`/redirect?${query}`, {
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
    });
    const location =
      typeof response.headers?.location === 'string'
        ? response.headers.location
        : '';
    const match = location.match(/\/(anime|tv|movies)\/(\d+)/);
    if (!match) return undefined;
    return {
      kind: match[1] as 'anime' | 'tv' | 'movies',
      simklId: match[2],
    };
  }

  /**
   * A known-good id used to disambiguate Simkl's overloaded `412`, which means
   * "unknown id in that catalog", "you sent HEAD", or a real credential failure.
   * A resolver that reads `412` as "blocked" disables Simkl on the first
   * not-found; one that reads it as "not found" never notices a suspension.
   *
   * Never uses HEAD: `HEAD /anime/39687` answers 412 while `GET` answers 200.
   */
  public async sentinelIsHealthy(): Promise<boolean> {
    try {
      const detail = await this.getTitle('anime', '39687');
      return Boolean(detail && Object.keys(detail).length);
    } catch {
      return false;
    }
  }

  /**
   * Write one episode's watch state using the catalog IDs and coordinates
   * returned to the caller.
   *
   * Simkl uses `use_tvdb_anime_seasons` to map TVDB/TMDB-shaped coordinates to
   * split or absolute-numbered anime entries. Set it only when the supplied
   * coordinates came from TVDB; TMDB coordinates must keep their own numbering.
   */
  public async setEpisodeHistory(
    ids: {
      simkl?: string | number;
      tmdb?: number;
      tvdb?: number;
      anidb?: number;
    },
    season: number,
    episode: number,
    watched: boolean,
    useTvdbAnimeSeasons = false
  ): Promise<unknown> {
    const identifiers = Object.fromEntries(
      Object.entries(ids).filter(([, value]) => Boolean(value))
    );
    if (!Object.keys(identifiers).length) {
      throw new Error('setEpisodeHistory requires at least one id');
    }
    return this.simklRequest(
      'post',
      watched ? '/sync/history' : '/sync/history/remove',
      {
        shows: [
          {
            ids: identifiers,
            ...(useTvdbAnimeSeasons ? { use_tvdb_anime_seasons: true } : {}),
            seasons: [{ number: season, episodes: [{ number: episode }] }],
          },
        ],
      }
    );
  }
}

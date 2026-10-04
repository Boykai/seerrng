// Adapted from selmant/foreseerr, copyright (c) 2026 Selman Trabzon. MIT licensed.
// See NOTICE.md for attribution and license terms.
import type {
  AnilistMedia,
  AnilistMediaListCollection,
  AnilistMediaListEntry,
  AnilistMediaListStatus,
  AnilistMediaPage,
  AnilistMediaSeason,
  AnilistMediaSort,
  AnilistMediaType,
  AnilistTokenResponse,
  AnilistTokenState,
  AnilistViewer,
} from '@server/api/anilist/interfaces';
import {
  ANILIST_GRAPHQL_URL,
  ANILIST_OAUTH_AUTHORIZE_URL,
  ANILIST_OAUTH_PIN_REDIRECT,
  ANILIST_OAUTH_TOKEN_URL,
} from '@server/api/anilist/interfaces';
import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import axios from 'axios';
import {
  AnilistAuthError,
  AnilistBadResponseError,
  AnilistGraphQLError,
  AnilistOutageError,
  AnilistRateLimitedError,
  classifyAnilistFailure,
  firstAnilistGraphQlError,
} from './failures';
import type {
  AnilistMalLinkPage,
  AnilistMangaContentPolicy,
  AnilistMangaDetails,
  AnilistMangaPage,
  AnilistMangaPageOptions,
  AnilistMangaSummary,
} from './manga';
import {
  ANILIST_MANGA_BATCH_SIZE,
  ANILIST_MANGA_DETAILS_TTL_SECONDS,
  ANILIST_MANGA_PAGE_TTL_SECONDS,
  MANGA_BY_IDS_QUERY,
  MANGA_DETAILS_QUERY,
  MANGA_IDS_BY_MAL_QUERY,
  MANGA_PAGE_QUERY,
  buildAnilistMangaPageVariables,
  sanitizeAnilistMalLinkPage,
  sanitizeAnilistMangaBatch,
  sanitizeAnilistMangaDetails,
  sanitizeAnilistMangaPage,
  sanitizeAnilistMangaSearch,
} from './manga';
import {
  ANILIST_DEFAULT_MAX_WAIT_MS,
  anilistRateLimiter,
  parseAnilistRetryAfterSeconds,
} from './rateLimiter';

export {
  AnilistAuthError,
  AnilistBadResponseError,
  AnilistGraphQLError,
  AnilistOutageError,
  AnilistRateLimitedError,
  classifyAnilistFailure,
} from './failures';

const ANILIST_PAGE_SIZE = 20;
const ANILIST_TITLE_SEARCH_SIZE = 5;
const ANILIST_TOKEN_TTL_FALLBACK_SECONDS = 365 * 24 * 60 * 60;
const PUBLIC_PAGE_CACHE_TTL_SECONDS = 300;

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  format
  episodes
  seasonYear
  startDate { year }
  coverImage { large medium }
`;

const PAGE_MEDIA_QUERY = `
  query PageMedia(
    $page: Int
    $perPage: Int
    $sort: [MediaSort]
    $season: MediaSeason
    $seasonYear: Int
    $type: MediaType
  ) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { currentPage hasNextPage lastPage perPage total }
      media(
        type: $type
        sort: $sort
        season: $season
        seasonYear: $seasonYear
      ) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const VIEWER_QUERY = `
  query Viewer {
    Viewer { id name }
  }
`;

const MEDIA_LIST_COLLECTION_QUERY = `
  query MediaListCollection($userId: Int!, $type: MediaType) {
    MediaListCollection(userId: $userId, type: $type) {
      lists {
        name
        isCustomList
        status
        entries {
          id
          status
          progress
          score(format: POINT_10)
          scoreRaw: score(format: POINT_100)
          media { ${MEDIA_FIELDS} }
        }
      }
    }
  }
`;

const MEDIA_QUERY = `
  query Media($id: Int, $type: MediaType) {
    Media(id: $id, type: $type) { ${MEDIA_FIELDS} }
  }
`;

const SAVE_MEDIA_LIST_ENTRY_MUTATION = `
  mutation SaveMediaListEntry(
    $mediaId: Int
    $status: MediaListStatus
    $scoreRaw: Int
    $progress: Int
  ) {
    SaveMediaListEntry(
      mediaId: $mediaId
      status: $status
      scoreRaw: $scoreRaw
      progress: $progress
    ) {
      id
      status
      progress
      score(format: POINT_10)
      scoreRaw: score(format: POINT_100)
      media { ${MEDIA_FIELDS} }
    }
  }
`;

const DELETE_MEDIA_LIST_ENTRY_MUTATION = `
  mutation DeleteMediaListEntry($id: Int) {
    DeleteMediaListEntry(id: $id) { deleted }
  }
`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message?: string; status?: number }[];
}

const retryAfterFromError = (error: unknown): number => {
  const headers = axios.isAxiosError(error)
    ? error.response?.headers
    : undefined;
  return parseAnilistRetryAfterSeconds(
    headers?.['retry-after'] ?? headers?.['Retry-After']
  );
};

interface AnilistAPIOptions {
  accessToken?: string;
  // How long a call may queue for the shared AniList budget before it fails
  // fast with AnilistRateLimitedError.
  maxRateLimitWaitMs?: number;
}

class AnilistAPI extends ExternalAPI {
  private accessToken?: string;
  private maxRateLimitWaitMs: number;

  constructor(options: AnilistAPIOptions = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (options.accessToken) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }

    super(
      ANILIST_GRAPHQL_URL,
      {},
      {
        headers,
        nodeCache: cacheManager.getCache('anilist').data,
      }
    );

    this.accessToken = options.accessToken;
    this.maxRateLimitWaitMs =
      options.maxRateLimitWaitMs ?? ANILIST_DEFAULT_MAX_WAIT_MS;
    // Interceptors run in reverse registration order, so the shared budget
    // is reserved before ExternalAPI's own request interceptors. Cache hits
    // and coalesced duplicates never reach this point.
    this.axios.interceptors.request.use(async (config) => {
      await anilistRateLimiter.acquire(this.maxRateLimitWaitMs);
      return config;
    });
  }

  static buildAuthorizeUrl(clientId: string): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: ANILIST_OAUTH_PIN_REDIRECT,
      response_type: 'code',
    });
    return `${ANILIST_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
  }

  static async exchangePinCode(
    clientId: string,
    clientSecret: string,
    code: string
  ): Promise<AnilistTokenState> {
    const tokenClient = axios.create({
      maxRedirects: 0,
      maxContentLength: 8 * 1024 * 1024,
      maxBodyLength: 1024 * 1024,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    tokenClient.interceptors.request.use(proxyRequestInterceptor);

    // The token endpoint is on AniList's host too, so it spends the same
    // per-IP budget as GraphQL calls.
    await anilistRateLimiter.acquire(ANILIST_DEFAULT_MAX_WAIT_MS);
    try {
      // The authorization code and client secret are intentionally sent to
      // AniList's fixed OAuth token endpoint.
      // codeql[js/file-access-to-http]
      const response = await tokenClient.post<AnilistTokenResponse>(
        ANILIST_OAUTH_TOKEN_URL,
        {
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: ANILIST_OAUTH_PIN_REDIRECT,
          code,
        }
      );
      const accessToken = String(response.data?.access_token ?? '').trim();
      if (!accessToken) {
        throw new AnilistAuthError('AniList did not return an access token');
      }
      const expiresIn =
        Number(response.data.expires_in) > 0
          ? Number(response.data.expires_in)
          : ANILIST_TOKEN_TTL_FALLBACK_SECONDS;
      return {
        accessToken,
        expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      };
    } catch (e) {
      if (e instanceof AnilistAuthError) {
        throw e;
      }
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (status === 429) {
        const retryAfterSeconds = retryAfterFromError(e);
        anilistRateLimiter.noteRateLimited(retryAfterSeconds);
        throw new AnilistRateLimitedError(retryAfterSeconds);
      }
      logger.warn('AniList PIN token exchange failed', {
        label: 'AniList API',
        status,
        errorMessage: e instanceof Error ? e.message : 'unknown error',
      });
      throw new AnilistAuthError(
        'Unable to exchange AniList authorization code'
      );
    }
  }

  static currentSeason(now = new Date()): {
    season: AnilistMediaSeason;
    year: number;
  } {
    const month = now.getMonth();
    const year = now.getFullYear();
    if (month <= 2) {
      return { season: 'WINTER', year };
    }
    if (month <= 5) {
      return { season: 'SPRING', year };
    }
    if (month <= 8) {
      return { season: 'SUMMER', year };
    }
    return { season: 'FALL', year };
  }

  static nextSeason(now = new Date()): {
    season: AnilistMediaSeason;
    year: number;
  } {
    const current = AnilistAPI.currentSeason(now);
    if (current.season === 'WINTER') {
      return { season: 'SPRING', year: current.year };
    }
    if (current.season === 'SPRING') {
      return { season: 'SUMMER', year: current.year };
    }
    if (current.season === 'SUMMER') {
      return { season: 'FALL', year: current.year };
    }
    return { season: 'WINTER', year: current.year + 1 };
  }

  async ping(): Promise<void> {
    // AniList rejects Page queries that only ask for pageInfo ("No field provided").
    await this.graphql<{
      Page: { pageInfo: { currentPage?: number }; media: { id: number }[] };
    }>(
      `query {
        Page(page: 1, perPage: 1) {
          pageInfo { currentPage }
          media { id }
        }
      }`,
      {},
      PUBLIC_PAGE_CACHE_TTL_SECONDS
    );
  }

  async getTrending(page = 1): Promise<AnilistMediaPage> {
    return this.getMediaPage(page, { sort: 'TRENDING_DESC' });
  }

  async getSeason(
    page = 1,
    season?: { season: AnilistMediaSeason; year: number }
  ): Promise<AnilistMediaPage> {
    const current = season ?? AnilistAPI.currentSeason();
    return this.getMediaPage(page, {
      sort: 'POPULARITY_DESC',
      season: current.season,
      seasonYear: current.year,
    });
  }

  async getPopular(page = 1): Promise<AnilistMediaPage> {
    return this.getMediaPage(page, { sort: 'POPULARITY_DESC' });
  }

  async getTop(page = 1): Promise<AnilistMediaPage> {
    return this.getMediaPage(page, { sort: 'SCORE_DESC' });
  }

  async getNextSeason(page = 1): Promise<AnilistMediaPage> {
    const next = AnilistAPI.nextSeason();
    return this.getMediaPage(page, {
      sort: 'POPULARITY_DESC',
      season: next.season,
      seasonYear: next.year,
    });
  }

  async getViewer(): Promise<AnilistViewer> {
    const data = await this.graphql<{ Viewer: AnilistViewer }>(
      VIEWER_QUERY,
      {},
      0
    );
    if (!data.Viewer?.id) {
      throw new AnilistAuthError('AniList Viewer query returned no user');
    }
    return data.Viewer;
  }

  async getMediaListCollection(
    userId: number,
    type: AnilistMediaType = 'ANIME'
  ): Promise<AnilistMediaListCollection> {
    const data = await this.graphql<{
      MediaListCollection: AnilistMediaListCollection;
    }>(MEDIA_LIST_COLLECTION_QUERY, { userId, type }, 0);
    return {
      lists: data.MediaListCollection?.lists ?? [],
    };
  }

  async getMedia(
    id: number,
    type: AnilistMediaType = 'ANIME'
  ): Promise<AnilistMedia | null> {
    const data = await this.graphql<{ Media: AnilistMedia | null }>(
      MEDIA_QUERY,
      { id, type },
      0
    );
    return data.Media ?? null;
  }

  async getMangaDetails(id: number): Promise<AnilistMangaDetails | null> {
    try {
      const data = await this.graphql<{ Media?: unknown }>(
        MANGA_DETAILS_QUERY,
        { id },
        ANILIST_MANGA_DETAILS_TTL_SECONDS
      );
      return sanitizeAnilistMangaDetails(data.Media) ?? null;
    } catch (e) {
      // AniList answers an unknown (or non-manga) id with a 404, either as
      // the HTTP status or inside the GraphQL error body.
      if (
        (axios.isAxiosError(e) && e.response?.status === 404) ||
        (e instanceof AnilistGraphQLError && e.status === 404)
      ) {
        return null;
      }
      throw e;
    }
  }

  async getMangaPage(
    options: AnilistMangaPageOptions
  ): Promise<AnilistMangaPage> {
    const data = await this.graphql<{ Page?: unknown }>(
      MANGA_PAGE_QUERY,
      buildAnilistMangaPageVariables(options, ANILIST_PAGE_SIZE),
      ANILIST_MANGA_PAGE_TTL_SECONDS
    );
    return sanitizeAnilistMangaPage(data.Page, options);
  }

  /**
   * Catalog cards for up to 50 AniList IDs in one cached request. Unknown
   * IDs are simply missing; the caller applies the content policy.
   */
  async getMangaSummariesByIds(
    ids: readonly number[]
  ): Promise<AnilistMangaSummary[]> {
    // Sorted, so the same set of IDs always shares one cache entry.
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    if (unique.length > ANILIST_MANGA_BATCH_SIZE) {
      throw new RangeError(
        `At most ${ANILIST_MANGA_BATCH_SIZE} manga can be read at once.`
      );
    }
    if (!unique.length) {
      return [];
    }
    const data = await this.graphql<{ Page?: unknown }>(
      MANGA_BY_IDS_QUERY,
      { ids: unique },
      ANILIST_MANGA_DETAILS_TTL_SECONDS
    );
    const media = sanitizeAnilistMangaBatch(data.Page, new Set(unique));
    if (!media) {
      throw new AnilistBadResponseError();
    }
    return media;
  }

  /**
   * One page of the AniList manga linked to these MyAnimeList IDs, for
   * library matching. An exact link ignores the content policy; nothing is
   * cached or shared with another caller.
   */
  async getMangaIdsByMalIds(
    malIds: readonly number[],
    page: number,
    options: { signal?: AbortSignal } = {}
  ): Promise<AnilistMalLinkPage> {
    const data = await this.graphql<{ Page?: unknown }>(
      MANGA_IDS_BY_MAL_QUERY,
      { page, malIds },
      0,
      options.signal
    );
    const result = sanitizeAnilistMalLinkPage(data.Page, new Set(malIds));
    if (!result) {
      throw new AnilistBadResponseError();
    }
    return result;
  }

  /** The best title matches for library matching, uncached. */
  async searchMangaTitles(
    search: string,
    policy: AnilistMangaContentPolicy,
    options: { signal?: AbortSignal } = {}
  ): Promise<AnilistMangaSummary[]> {
    const data = await this.graphql<{ Page?: unknown }>(
      MANGA_PAGE_QUERY,
      buildAnilistMangaPageVariables(
        { ...policy, page: 1, sort: ['SEARCH_MATCH'], search },
        ANILIST_TITLE_SEARCH_SIZE
      ),
      0,
      options.signal
    );
    const media = sanitizeAnilistMangaSearch(data.Page, policy);
    if (!media) {
      throw new AnilistBadResponseError();
    }
    return media;
  }

  async saveMediaListEntry(options: {
    mediaId: number;
    status?: AnilistMediaListStatus;
    scoreRaw?: number | null;
    progress?: number | null;
  }): Promise<AnilistMediaListEntry> {
    const variables: Record<string, unknown> = { mediaId: options.mediaId };
    if (options.status) {
      variables.status = options.status;
    }
    if (options.scoreRaw != null) {
      variables.scoreRaw = options.scoreRaw;
    }
    if (options.progress != null) {
      variables.progress = options.progress;
    }
    const data = await this.graphql<{
      SaveMediaListEntry: AnilistMediaListEntry;
    }>(SAVE_MEDIA_LIST_ENTRY_MUTATION, variables, 0);
    return data.SaveMediaListEntry;
  }

  async deleteMediaListEntry(entryId: number): Promise<boolean> {
    const data = await this.graphql<{
      DeleteMediaListEntry: { deleted?: boolean } | null;
    }>(DELETE_MEDIA_LIST_ENTRY_MUTATION, { id: entryId }, 0);
    return Boolean(data.DeleteMediaListEntry?.deleted);
  }

  mediaTitle(media?: AnilistMedia | null): string {
    return (
      media?.title?.english?.trim() ||
      media?.title?.romaji?.trim() ||
      media?.title?.native?.trim() ||
      ''
    );
  }

  private async getMediaPage(
    page: number,
    options: {
      sort: AnilistMediaSort;
      season?: AnilistMediaSeason;
      seasonYear?: number;
      type?: AnilistMediaType;
    }
  ): Promise<AnilistMediaPage> {
    const type = options.type ?? 'ANIME';
    const data = await this.graphql<{ Page: AnilistMediaPage }>(
      PAGE_MEDIA_QUERY,
      {
        page,
        perPage: ANILIST_PAGE_SIZE,
        type,
        sort: [options.sort],
        season: options.season,
        seasonYear: options.seasonYear,
      },
      PUBLIC_PAGE_CACHE_TTL_SECONDS
    );
    return {
      pageInfo: data.Page?.pageInfo ?? {
        hasNextPage: false,
        currentPage: page,
      },
      media: (data.Page?.media ?? []).filter(
        (item) => item?.id && (type !== 'ANIME' || item.format !== 'MUSIC')
      ),
    };
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    ttl: number,
    signal?: AbortSignal
  ): Promise<T> {
    try {
      const auth = this.accessToken
        ? { headers: { Authorization: `Bearer ${this.accessToken}` } }
        : undefined;
      const response = await this.post<GraphQLResponse<T>>(
        '',
        { query, variables },
        signal ? { ...auth, signal } : auth,
        ttl
      );

      const graphQlError = firstAnilistGraphQlError(response);
      const classified = classifyAnilistFailure({
        graphQlStatus: graphQlError.status,
        message: graphQlError.message,
      });
      if (classified) {
        throw classified;
      }
      if (response.errors?.length) {
        throw new AnilistGraphQLError(
          response.errors[0]?.message || 'AniList GraphQL error',
          graphQlError.status
        );
      }
      if (!response.data) {
        throw new AnilistGraphQLError('AniList returned an empty response');
      }
      return response.data;
    } catch (e) {
      if (
        e instanceof AnilistAuthError ||
        e instanceof AnilistGraphQLError ||
        e instanceof AnilistOutageError ||
        e instanceof AnilistRateLimitedError
      ) {
        throw e;
      }
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (status === 429) {
        const retryAfterSeconds = retryAfterFromError(e);
        anilistRateLimiter.noteRateLimited(retryAfterSeconds);
        throw new AnilistRateLimitedError(retryAfterSeconds);
      }
      const graphQlError = firstAnilistGraphQlError(
        axios.isAxiosError(e) ? e.response?.data : undefined
      );
      const classified = classifyAnilistFailure({
        httpStatus: status,
        graphQlStatus: graphQlError.status,
        message: graphQlError.message,
      });
      if (classified) {
        throw classified;
      }
      throw e;
    }
  }
}

export default AnilistAPI;

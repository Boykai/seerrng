import { parseAnilistRetryAfterSeconds } from '@server/api/anilist/rateLimiter';
import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import { recordExternalApiCall } from '@server/lib/metrics';
import { getAppVersion } from '@server/utils/appVersion';
import axios from 'axios';
import { setTimeout as delay } from 'node:timers/promises';

export const MANGADEX_API_URL = 'https://api.mangadex.org';
export const MANGADEX_MAX_IDS_PER_REQUEST = 100;
export const MANGADEX_TITLE_SEARCH_LIMIT = 10;
export const MANGADEX_MAX_TITLE_LENGTH = 200;

// MangaDex allows about five requests a second per IP and bans a client that
// keeps sending through 429s, so requests stay a second apart and a refusal
// pauses every request until its cooldown ends.
const MIN_REQUEST_SPACING_MS = 1_000;
const FORBIDDEN_COOLDOWN_SECONDS = 3_600;
const LINK_CACHE_TTL_SECONDS = 86_400;
const MAX_INT32 = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// An exact link ignores the content policy, so no rating may hide a title.
const CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'];

/** MangaDex refused a request, or the cooldown after a refusal still runs. */
export class MangaDexRateLimitedError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    public readonly requestSent: boolean
  ) {
    super(`MangaDex rate limited; retry after ${retryAfterSeconds}s`);
    this.name = 'MangaDexRateLimitedError';
  }
}

/** A reply that does not answer every requested ID. */
export class MangaDexBadResponseError extends Error {
  constructor() {
    super('MangaDex returned an incomplete or malformed response');
    this.name = 'MangaDexBadResponseError';
  }
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = (ms, signal) => delay(ms, undefined, { signal });

// MangaDex limits per client IP, so the whole process shares one limiter.
class MangaDexLimiter {
  private nextStart = 0;
  private cooldownUntil = 0;
  private now: () => number = Date.now;
  private sleep: Sleep = defaultSleep;

  configure(options: { now?: () => number; sleep?: Sleep } = {}): void {
    this.nextStart = 0;
    this.cooldownUntil = 0;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const now = this.now();
      if (this.cooldownUntil > now) {
        throw new MangaDexRateLimitedError(
          Math.ceil((this.cooldownUntil - now) / 1000),
          false
        );
      }
      if (this.nextStart <= now) {
        this.nextStart = now + MIN_REQUEST_SPACING_MS;
        return;
      }
      await this.sleep(this.nextStart - now, signal);
    }
  }

  /** Start the cooldown for a 429 or 403 and return its length in seconds. */
  refuse(status: number, retryAfter: unknown): number {
    const now = this.now();
    const seconds =
      status === 403
        ? FORBIDDEN_COOLDOWN_SECONDS
        : parseAnilistRetryAfterSeconds(retryAfter, now);
    this.cooldownUntil = Math.max(this.cooldownUntil, now + seconds * 1000);
    return seconds;
  }
}

const limiter = new MangaDexLimiter();

/** Test helper: clear the limiter and optionally inject a clock. */
export const resetMangaDexLimiterForTests = (
  options: { now?: () => number; sleep?: Sleep } = {}
): void => limiter.configure(options);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const parseAniListId = (value: unknown): number | null =>
  typeof value === 'string' &&
  /^[1-9]\d{0,9}$/.test(value) &&
  Number(value) <= MAX_INT32
    ? Number(value)
    : null;

/** Each requested ID's AniList link, or undefined for an incomplete reply. */
const parseLinks = (
  value: unknown,
  requested: readonly string[]
): Map<string, number | null> | undefined => {
  if (
    !isRecord(value) ||
    value.result !== 'ok' ||
    !Array.isArray(value.data) ||
    typeof value.total !== 'number' ||
    value.total > value.data.length
  ) {
    return undefined;
  }
  const links = new Map<string, number | null>(
    requested.map((uuid) => [uuid, null])
  );
  for (const entry of value.data) {
    if (
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      links.get(entry.id) === null &&
      isRecord(entry.attributes) &&
      isRecord(entry.attributes.links)
    ) {
      links.set(entry.id, parseAniListId(entry.attributes.links.al));
    }
  }
  return links;
};

/** A MangaDex title search result and the AniList ID it links to. */
export interface MangaDexTitleMatch {
  uuid: string;
  anilistId: number | null;
}

/** The results in order, or undefined for a malformed reply. */
const parseTitleMatches = (
  value: unknown
): MangaDexTitleMatch[] | undefined => {
  if (!isRecord(value) || value.result !== 'ok' || !Array.isArray(value.data)) {
    return undefined;
  }
  const entries: unknown[] = value.data.slice(0, MANGADEX_TITLE_SEARCH_LIMIT);
  const matches = new Map<string, number | null>();
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !UUID.test(entry.id.toLowerCase()) ||
      !isRecord(entry.attributes)
    ) {
      return undefined;
    }
    const uuid = entry.id.toLowerCase();
    // MangaDex sends an empty array, not an object, when a title has no links.
    const { links } = entry.attributes;
    if (!matches.has(uuid)) {
      matches.set(uuid, isRecord(links) ? parseAniListId(links.al) : null);
    }
  }
  return [...matches].map(([uuid, anilistId]) => ({ uuid, anilistId }));
};

/**
 * Read-only MangaDex client for matching. Requests carry only MangaDex manga
 * UUIDs or title text, never a source or an address.
 */
class MangaDexAPI extends ExternalAPI {
  constructor() {
    super(
      MANGADEX_API_URL,
      {},
      { headers: { 'User-Agent': `SeerrNG/${getAppVersion()}` } }
    );
  }

  /** One `GET /manga` through the shared limiter; refusals start a cooldown. */
  private async getManga(
    query: URLSearchParams,
    signal?: AbortSignal
  ): Promise<unknown> {
    await limiter.acquire(signal);
    recordExternalApiCall('GET');
    try {
      // Straight to axios: ExternalAPI's GET retry would resend after a 429.
      const { data } = await this.axios.get<unknown>(
        `${MANGADEX_API_URL}/manga?${query.toString()}`,
        { signal }
      );
      return data;
    } catch (error) {
      const response = axios.isAxiosError(error) ? error.response : undefined;
      if (response?.status === 429 || response?.status === 403) {
        throw new MangaDexRateLimitedError(
          limiter.refuse(response.status, response.headers?.['retry-after']),
          true
        );
      }
      throw error;
    }
  }

  /**
   * The AniList ID that MangaDex links to each UUID, or null when it has no
   * usable link or does not know the UUID. The call answers every UUID or
   * throws, so a caller never records part of a reply.
   */
  async getAniListLinks(
    uuids: readonly string[],
    options: { signal?: AbortSignal } = {}
  ): Promise<Map<string, number | null>> {
    const requested = [...new Set(uuids)];
    if (
      requested.length > MANGADEX_MAX_IDS_PER_REQUEST ||
      requested.some((uuid) => !UUID.test(uuid))
    ) {
      throw new TypeError('Expected at most 100 lowercase MangaDex UUIDs');
    }
    const cache = cacheManager.getCache('mangadex').data;
    const result = new Map<string, number | null>();
    const missing: string[] = [];
    for (const uuid of requested) {
      const cached = cache.get<number | null>(uuid);
      if (cached === undefined) {
        missing.push(uuid);
      } else {
        result.set(uuid, cached);
      }
    }
    if (missing.length === 0) {
      return result;
    }

    const query = new URLSearchParams();
    missing.forEach((uuid) => query.append('ids[]', uuid));
    query.set('limit', String(missing.length));
    query.set('offset', '0');
    CONTENT_RATINGS.forEach((rating) =>
      query.append('contentRating[]', rating)
    );
    const links = parseLinks(
      await this.getManga(query, options.signal),
      missing
    );
    if (!links) {
      throw new MangaDexBadResponseError();
    }
    for (const [uuid, anilistId] of links) {
      cache.set(uuid, anilistId, LINK_CACHE_TTL_SECONDS);
      result.set(uuid, anilistId);
    }
    return result;
  }

  /**
   * The MangaDex titles that match `title`, most relevant first, each with
   * the AniList ID it links to. Sends only the title text; every content
   * rating, since an exact link ignores the content policy.
   */
  async searchMangaByTitle(
    title: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<MangaDexTitleMatch[]> {
    const text = title.trim();
    if (!text || text.length > MANGADEX_MAX_TITLE_LENGTH) {
      throw new TypeError('Expected a title of 1 to 200 characters');
    }
    const cache = cacheManager.getCache('mangadex').data;
    // Prefixed so it never collides with the bare-UUID link entries.
    const key = `title:${text}`;
    const cached = cache.get<MangaDexTitleMatch[]>(key);
    if (cached !== undefined) {
      return cached;
    }
    const query = new URLSearchParams();
    query.set('title', text);
    query.set('limit', String(MANGADEX_TITLE_SEARCH_LIMIT));
    query.set('offset', '0');
    CONTENT_RATINGS.forEach((rating) =>
      query.append('contentRating[]', rating)
    );
    query.set('order[relevance]', 'desc');
    const matches = parseTitleMatches(
      await this.getManga(query, options.signal)
    );
    if (!matches) {
      throw new MangaDexBadResponseError();
    }
    cache.set(key, matches, LINK_CACHE_TTL_SECONDS);
    return matches;
  }
}

export default MangaDexAPI;

import ExternalAPI from '@server/api/externalapi';
import {
  SuwayomiTokenManager,
  basicAuthorization,
  type SuwayomiTokens,
} from '@server/api/suwayomi/auth';
import { evaluateCapabilities } from '@server/api/suwayomi/capabilities';
import {
  SuwayomiError,
  authStatusCode,
  interpretGraphQLResponse,
  isRecord,
  readHeader,
  reportSuwayomiError,
  toSuwayomiError,
  type GraphQLResult,
  type SuwayomiErrorCode,
} from '@server/api/suwayomi/errors';
import {
  HAS_CONTROL_CHARACTER,
  META_VALUE_LIMIT,
  badResponse,
  list,
  mapAvailability,
  mapCategory,
  mapChapter,
  mapChapterState,
  mapHealth,
  mapMangaDetails,
  mapMangaSummary,
  mapQueue,
  mapSource,
  nodes,
  record,
} from '@server/api/suwayomi/mappers';
import {
  REQUEST_INDEX_PREFIX,
  SUWAYOMI_OPERATIONS,
  type SuwayomiAuthLevel,
  type SuwayomiOperationName,
} from '@server/api/suwayomi/operations';
import type {
  SuwayomiAPIOptions,
  SuwayomiArchiveInfo,
  SuwayomiAuthDetection,
  SuwayomiAuthMode,
  SuwayomiAuthWarning,
  SuwayomiAvailabilitySnapshot,
  SuwayomiByteStream,
  SuwayomiCallClass,
  SuwayomiCallOptions,
  SuwayomiCapabilities,
  SuwayomiCategory,
  SuwayomiChapter,
  SuwayomiChapterState,
  SuwayomiDetectedAuthMode,
  SuwayomiFetchResult,
  SuwayomiHealth,
  SuwayomiMangaDetails,
  SuwayomiMutationResult,
  SuwayomiQueue,
  SuwayomiRequestIndexEntry,
  SuwayomiSearchPage,
  SuwayomiSource,
  SuwayomiTimeouts,
} from '@server/api/suwayomi/types';
import logger from '@server/logger';
import type { AxiosResponse } from 'axios';
import { Readable, Transform } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

const GRAPHQL_PATH = 'api/graphql';
const BEARER = 'Bearer ';
const LOCAL_SOURCE_ID = '0';
export const DEFAULT_SUWAYOMI_TIMEOUTS: Readonly<SuwayomiTimeouts> = {
  query: 15_000,
  mutation: 15_000,
  // Suwayomi waits up to 30 s for the downloader before answering.
  queue: 45_000,
  source: 150_000,
  bytes: 45_000,
};
export const DEFAULT_CHAPTER_ARCHIVE_LIMIT_BYTES = 1024 ** 3;
export const DEFAULT_THUMBNAIL_LIMIT_BYTES = 10 * 1024 ** 2;
const MAX_IDS_PER_CALL = 100;
const MAX_INDEX_PAGES = 100;
const MAX_INT = 2_147_483_647;
const MAX_LONG = 9_223_372_036_854_775_807n;
const REQUEST_ID_PATTERN = /^[1-9]\d{0,9}$/;
const REQUEST_INDEX_KEY_PATTERN = /^seerrng\.request\.([1-9]\d{0,9})$/;
const TOKEN_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]*$/;
const SUPPORTED_MODES = new Set<SuwayomiDetectedAuthMode>([
  'NONE',
  'BASIC_AUTH',
  'UI_LOGIN',
]);
const READBACK_CODES = new Set<SuwayomiErrorCode>([
  'TIMEOUT',
  'UNREACHABLE',
  'UPSTREAM_ERROR',
]);
const warnedModes = new Set<string>();

interface PostOptions extends SuwayomiCallOptions {
  /** Only for operations whose root fields all require a user. */
  allowPartial?: boolean;
  /** How to read a 401; detection probes interpret it as unconfigured. */
  interpretAs?: SuwayomiAuthMode;
}

const invalid = (operation: string): never => {
  throw new SuwayomiError('INVALID_ARGUMENT', operation);
};

const failureCode = (error: unknown) =>
  error instanceof SuwayomiError ? error.code : undefined;

const intId = (value: string, operation: string, min = 0): number => {
  const id =
    typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : -1;
  return id >= min && id <= MAX_INT ? id : invalid(operation);
};

const intIds = (values: readonly string[], operation: string): number[] =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.length <= MAX_IDS_PER_CALL
    ? [...new Set(values.map((value) => intId(value, operation)))]
    : invalid(operation);

const longId = (value: string, operation: string): string =>
  typeof value === 'string' &&
  /^\d{1,19}$/.test(value) &&
  BigInt(value) <= MAX_LONG
    ? value
    : invalid(operation);

const boundedText = (value: string, max: number, operation: string): string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max
    ? value
    : invalid(operation);

const metaValue = (value: string, operation: string): string =>
  typeof value === 'string' && value.length <= META_VALUE_LIMIT
    ? value
    : invalid(operation);

const requestIndexKey = (requestId: string, operation: string): string =>
  typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId)
    ? `${REQUEST_INDEX_PREFIX}${requestId}`
    : invalid(operation);

/** Suwayomi reserves the name of its built-in default category. */
const categoryName = (name: string, operation: string): string =>
  typeof name === 'string' &&
  name === name.trim() &&
  name.length > 0 &&
  name.length <= 64 &&
  !HAS_CONTROL_CHARACTER.test(name) &&
  name.toLowerCase() !== 'default'
    ? name
    : invalid(operation);

const configuredNumber = (
  value: number | undefined,
  fallback: number,
  min: number
): number => {
  if (value === undefined) {
    return fallback;
  }
  return Number.isSafeInteger(value) && value >= min
    ? value
    : invalid('configure');
};

const jwt = (value: unknown, operation: string): string =>
  typeof value === 'string' &&
  value.length <= 8_192 &&
  TOKEN_PATTERN.test(value)
    ? value
    : badResponse(operation);

const mediaType = (value: string | undefined): string | undefined => {
  const type = value?.split(';')[0].trim().toLowerCase();
  return type && type.length <= 100 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)
    ? type
    : undefined;
};

const parseBaseUrl = (value: string): string => {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return invalid('configure');
  }
  url.search = '';
  url.hash = '';
  return url.href;
};

/**
 * Client for one Suwayomi-Server instance over its GraphQL API and the two
 * REST byte routes. Every failure surfaces as a {@link SuwayomiError} with a
 * stable code; upstream error text is classified and then discarded.
 */
class SuwayomiAPI extends ExternalAPI {
  readonly authMode: SuwayomiAuthMode;
  readonly #origin: string;
  readonly #credentials?: { username: string; password: string };
  readonly #basicAuthorization?: string;
  readonly #tokens?: SuwayomiTokenManager;
  readonly #timeouts: SuwayomiTimeouts;
  readonly #limits: { chapterArchiveBytes: number; thumbnailBytes: number };
  readonly #readback: { attempts: number; delayMs: number };
  readonly #warnInsecureAuthMode: boolean;

  constructor(options: SuwayomiAPIOptions) {
    const baseUrl = parseBaseUrl(options?.url);
    // An administrator configures this URL, and Suwayomi normally runs on a
    // private network next to SeerrNG (the same policy as Kapowarr and Mylar).
    super(baseUrl, {}, { allowPrivateAddresses: true });

    const auth = options.auth;
    if (
      !isRecord(auth) ||
      !['UI_LOGIN', 'BASIC_AUTH', 'NONE'].includes(auth.mode)
    ) {
      throw new SuwayomiError('AUTH_MODE_UNSUPPORTED', 'configure');
    }
    this.authMode = auth.mode;
    if (auth.mode !== 'NONE') {
      const { username, password } = auth;
      if (typeof username !== 'string' || typeof password !== 'string') {
        invalid('configure');
      }
      this.#credentials = { username, password };
      if (auth.mode === 'BASIC_AUTH') {
        this.#basicAuthorization = basicAuthorization(username, password);
      } else {
        this.#tokens = new SuwayomiTokenManager({
          login: () => this.login(),
          refresh: (refreshToken) => this.refresh(refreshToken),
        });
      }
    }

    const timeouts = options.timeouts ?? {};
    this.#timeouts = { ...DEFAULT_SUWAYOMI_TIMEOUTS };
    for (const key of Object.keys(this.#timeouts) as SuwayomiCallClass[]) {
      this.#timeouts[key] = configuredNumber(
        timeouts[key],
        DEFAULT_SUWAYOMI_TIMEOUTS[key],
        1
      );
    }
    this.#limits = {
      chapterArchiveBytes: configuredNumber(
        options.limits?.chapterArchiveBytes,
        DEFAULT_CHAPTER_ARCHIVE_LIMIT_BYTES,
        1
      ),
      thumbnailBytes: configuredNumber(
        options.limits?.thumbnailBytes,
        DEFAULT_THUMBNAIL_LIMIT_BYTES,
        1
      ),
    };
    this.#readback = {
      attempts: configuredNumber(options.readback?.attempts, 2, 0),
      delayMs: configuredNumber(options.readback?.delayMs, 1_000, 0),
    };
    this.#origin = new URL(baseUrl).origin;
    this.#warnInsecureAuthMode = options.warnInsecureAuthMode !== false;
    this.warnAboutMode(auth.mode);
  }

  /** Identifies the server's auth mode and checks the configured credentials. */
  async detectAuthMode(
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiAuthDetection> {
    const { signal } = options;
    const configured = this.authMode;
    const warnings = new Set<SuwayomiAuthWarning>();
    if (
      this.#credentials &&
      (!this.#credentials.username || !this.#credentials.password)
    ) {
      warnings.add('EMPTY_CREDENTIALS');
    }
    const detected = (
      mode: SuwayomiDetectedAuthMode,
      authenticated: boolean
    ): SuwayomiAuthDetection => {
      if (mode !== configured) warnings.add('MODE_MISMATCH');
      if (mode === 'NONE') warnings.add('AUTH_DISABLED');
      if (mode === 'BASIC_AUTH') warnings.add('BASIC_AUTH_IN_USE');
      this.warnAboutMode(mode);
      return {
        mode,
        supported: SUPPORTED_MODES.has(mode),
        authenticated,
        matchesConfigured: mode === configured,
        warnings: [...warnings],
      };
    };

    try {
      // 1. Without credentials, a Basic challenge identifies BASIC_AUTH.
      try {
        await this.postGraphQL('Probe', undefined, undefined, {
          signal,
          interpretAs: 'NONE',
        });
      } catch (error) {
        if (failureCode(error) === 'AUTH_MODE_MISMATCH') {
          if (!this.#basicAuthorization) {
            return detected('BASIC_AUTH', false);
          }
          await this.postGraphQL(
            'AuthTest',
            undefined,
            this.#basicAuthorization,
            {
              signal,
              interpretAs: 'BASIC_AUTH',
            }
          );
          return detected('BASIC_AUTH', true);
        }
        if (failureCode(error) !== 'AUTH_REQUIRED') throw error;
      }

      // 2. A protected query that succeeds anonymously means NONE.
      try {
        await this.postGraphQL('AuthTest', undefined, undefined, {
          signal,
          interpretAs: 'NONE',
        });
        return detected('NONE', configured !== 'UI_LOGIN');
      } catch (error) {
        if (failureCode(error) !== 'AUTH_REQUIRED') throw error;
      }

      // 3. SIMPLE_LOGIN issues tokens from `login` but ignores them.
      if (!this.#credentials) {
        return detected('LOGIN_REQUIRED', false);
      }
      const tokens = await this.login(signal);
      try {
        await this.postGraphQL(
          'AuthTest',
          undefined,
          `${BEARER}${tokens.accessToken}`,
          {
            signal,
            interpretAs: 'UI_LOGIN',
          }
        );
      } catch (error) {
        if (failureCode(error) !== 'AUTH_REQUIRED') throw error;
        return detected('SIMPLE_LOGIN', false);
      }
      this.#tokens?.seed(tokens);
      return detected('UI_LOGIN', configured === 'UI_LOGIN');
    } catch (error) {
      throw reportSuwayomiError(toSuwayomiError(error, 'AuthDetection'));
    }
  }

  async getCapabilities(
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiCapabilities> {
    try {
      return await this.run('Capabilities', undefined, options, (data) => {
        const schema = record(data.__schema, 'Capabilities');
        return evaluateCapabilities({
          about: data.aboutServer,
          introspection: {
            queryType: schema.queryType,
            mutationType: schema.mutationType,
            mangaType: data.mangaType,
            chapterType: data.chapterType,
          },
        });
      });
    } catch (error) {
      const code = failureCode(error);
      if (code !== 'UPSTREAM_ERROR' && code !== 'BAD_RESPONSE') throw error;
      return this.run('Probe', undefined, options, (data) =>
        evaluateCapabilities({ about: data.aboutServer })
      );
    }
  }

  async getHealth(options: SuwayomiCallOptions = {}): Promise<SuwayomiHealth> {
    return this.run('Health', undefined, options, (data) =>
      mapHealth(data, 'Health')
    );
  }

  /** Installed sources, without the built-in local source. */
  async getSources(
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiSource[]> {
    return this.run('Sources', undefined, options, (data) =>
      nodes(data.sources, 'Sources')
        .map((node) => mapSource(node, 'Sources'))
        .filter((source) => source.id !== LOCAL_SOURCE_ID)
    );
  }

  async searchSource(
    sourceId: string,
    query: string,
    page = 1,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiSearchPage> {
    const op = 'SearchSource';
    const variables = {
      source: longId(sourceId, op),
      query: boundedText(query, 200, op),
      page:
        Number.isInteger(page) && page >= 1 && page <= 1_000
          ? page
          : invalid(op),
    };
    return this.run(op, variables, options, (data) => {
      const payload = record(data.fetchSourceManga, op);
      return {
        hasNextPage: payload.hasNextPage === true,
        mangas: list(payload.mangas, op).map((manga) =>
          mapMangaSummary(manga, op)
        ),
      };
    });
  }

  /** Prefers the lowest ID in the library, then the lowest ID. */
  async findMangaByNaturalKey(
    sourceId: string,
    url: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiMangaDetails | undefined> {
    const op = 'ByNaturalKey';
    const variables = {
      sourceId: longId(sourceId, op),
      url: boundedText(url, 2_048, op),
    };
    return this.run(op, variables, options, (data) => {
      const matches = nodes(data.mangas, op)
        .map((node) => mapMangaDetails(node, op))
        .sort((a, b) => Number(a.id) - Number(b.id));
      return matches.find((manga) => manga.inLibrary) ?? matches[0];
    });
  }

  async getMangaDetails(
    mangaId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiMangaDetails> {
    const op = 'MangaDetails';
    return this.run(op, { id: intId(mangaId, op) }, options, (data) =>
      mapMangaDetails(data.manga, op)
    );
  }

  /**
   * Fetches from the source. Cached data that Suwayomi returns alongside an
   * error is reported with `fresh: false`; a client timeout is confirmed by
   * reading the stored manga back before it counts as a failure.
   */
  async fetchMangaAndChapters(
    mangaId: string,
    options: SuwayomiCallOptions & { fetchManga?: boolean } = {}
  ): Promise<SuwayomiFetchResult> {
    const op = 'FetchMangaAndChapters';
    const variables = {
      id: intId(mangaId, op),
      fetchManga: options.fetchManga ?? true,
    };
    try {
      return await this.run(
        op,
        variables,
        options,
        (data, result): SuwayomiFetchResult => {
          const partial = result.errorCode !== undefined;
          const payload = isRecord(data.fetchMangaAndChapters)
            ? data.fetchMangaAndChapters
            : invalidPayload(partial, op, result.errorCount);
          const manga =
            partial && payload.manga == null
              ? undefined
              : mapMangaDetails(payload.manga, op);
          const chapters =
            partial && payload.chapters == null
              ? undefined
              : list(payload.chapters, op).map((chapter) =>
                  mapChapter(chapter, op)
                );
          return partial
            ? { fresh: false, issue: 'UPSTREAM_ERROR', manga, chapters }
            : { fresh: true, manga, chapters };
        },
        true
      );
    } catch (error) {
      if (failureCode(error) !== 'TIMEOUT') throw error;
      const manga = await this.getMangaDetails(mangaId, options).catch(
        () => undefined
      );
      if (!manga) throw error;
      return { fresh: false, issue: 'TIMEOUT', manga };
    }
  }

  async findCategory(
    name: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiCategory | undefined> {
    const op = 'FindCategory';
    return this.run(op, { name: categoryName(name, op) }, options, (data) =>
      nodes(data.categories, op)
        .map((node) => mapCategory(node, op))
        .find((category) => category.name === name)
    );
  }

  /** Leaves the category's update and download inclusion unset. */
  async createCategory(
    name: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiCategory> {
    const op = 'CreateCategory';
    return this.run(op, { name: categoryName(name, op) }, options, (data) =>
      mapCategory(record(data.createCategory, op).category, op)
    );
  }

  async findOrCreateCategory(
    name: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiCategory> {
    const existing = await this.findCategory(name, options);
    if (existing) return existing;
    try {
      return await this.createCategory(name, options);
    } catch (error) {
      // Another writer may have created it first; read again before failing.
      const created = await this.findCategory(name, options).catch(
        () => undefined
      );
      if (created) return created;
      throw error;
    }
  }

  async setInLibrary(
    mangaId: string,
    inLibrary: boolean,
    options: SuwayomiCallOptions = {}
  ): Promise<void> {
    const op = 'SetInLibrary';
    const variables = {
      id: intId(mangaId, op),
      inLibrary: typeof inLibrary === 'boolean' ? inLibrary : invalid(op),
    };
    await this.run(op, variables, options, (data) =>
      record(data.updateManga, op)
    );
  }

  async addMangaToCategory(
    mangaId: string,
    categoryId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<void> {
    await this.updateCategories(
      'AddMangaToCategory',
      mangaId,
      categoryId,
      options
    );
  }

  async removeMangaFromCategory(
    mangaId: string,
    categoryId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<void> {
    await this.updateCategories(
      'RemoveMangaFromCategory',
      mangaId,
      categoryId,
      options
    );
  }

  async setRequestStamp(
    mangaId: string,
    value: string,
    options: SuwayomiCallOptions = {}
  ): Promise<void> {
    const op = 'SetRequestStamp';
    const variables = {
      mangaId: intId(mangaId, op),
      value: metaValue(value, op),
    };
    await this.run(op, variables, options, (data) =>
      record(data.setMangaMeta, op)
    );
  }

  async deleteRequestStamp(
    mangaId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<void> {
    const op = 'DeleteRequestStamp';
    await this.deleteMeta(op, { mangaId: intId(mangaId, op) }, options);
  }

  async setRequestIndex(
    requestId: string,
    value: string,
    options: SuwayomiCallOptions = {}
  ): Promise<void> {
    const op = 'SetRequestIndex';
    const variables = {
      key: requestIndexKey(requestId, op),
      value: metaValue(value, op),
    };
    await this.run(op, variables, options, (data) =>
      record(data.setGlobalMeta, op)
    );
  }

  async deleteRequestIndex(
    requestId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<void> {
    const op = 'DeleteRequestIndex';
    await this.deleteMeta(op, { key: requestIndexKey(requestId, op) }, options);
  }

  async listRequestIndex(
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiRequestIndexEntry[]> {
    const op = 'ReverseIndex';
    const entries: SuwayomiRequestIndexEntry[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
      const next: string | undefined = await this.run(
        op,
        { after },
        options,
        (data) => {
          const metas = record(data.metas, op);
          for (const node of nodes(metas, op)) {
            const entry: Record<string, unknown> = isRecord(node) ? node : {};
            const match =
              typeof entry.key === 'string'
                ? REQUEST_INDEX_KEY_PATTERN.exec(entry.key)
                : null;
            if (
              match &&
              typeof entry.value === 'string' &&
              entry.value.length <= META_VALUE_LIMIT
            ) {
              entries.push({ requestId: match[1], value: entry.value });
            }
          }
          const pageInfo = isRecord(metas.pageInfo) ? metas.pageInfo : {};
          const cursor = pageInfo.endCursor;
          return pageInfo.hasNextPage === true &&
            typeof cursor === 'string' &&
            cursor.length <= 256 &&
            cursor !== after
            ? cursor
            : undefined;
        }
      );
      if (next === undefined) break;
      after = next;
    }
    return entries;
  }

  async getInstanceMarker(
    options: SuwayomiCallOptions = {}
  ): Promise<string | undefined> {
    try {
      return await this.run('InstanceMarker', undefined, options, (data) =>
        isRecord(data.meta) && typeof data.meta.value === 'string'
          ? data.meta.value
          : undefined
      );
    } catch (error) {
      if (failureCode(error) === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  async setInstanceMarker(
    value: string,
    options: SuwayomiCallOptions = {}
  ): Promise<void> {
    const op = 'SetInstanceMarker';
    await this.run(op, { value: metaValue(value, op) }, options, (data) =>
      record(data.setGlobalMeta, op)
    );
  }

  async getChaptersToDownload(
    mangaId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiChapter[]> {
    return this.listChapters('ChaptersToDownload', mangaId, options);
  }

  async getDownloadedChapters(
    mangaId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiChapter[]> {
    return this.listChapters('DownloadedChapters', mangaId, options);
  }

  async getChapterStates(
    chapterIds: readonly string[],
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiChapterState[]> {
    const op = 'ChapterStates';
    return this.run(op, { ids: intIds(chapterIds, op) }, options, (data) =>
      nodes(data.chapters, op).map((node) => mapChapterState(node, op))
    );
  }

  async getQueue(options: SuwayomiCallOptions = {}): Promise<SuwayomiQueue> {
    return this.run('Queue', undefined, options, (data) =>
      mapQueue(data.downloadStatus, 'Queue')
    );
  }

  async getAvailability(
    mangaIds: readonly string[],
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiAvailabilitySnapshot> {
    const op = 'Availability';
    return this.run(op, { ids: intIds(mangaIds, op) }, options, (data) => ({
      mangas: nodes(data.mangas, op).map((node) => mapAvailability(node, op)),
      queue: mapQueue(data.downloadStatus, op),
    }));
  }

  async enqueueChapters(
    chapterIds: readonly string[],
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiMutationResult> {
    const op = 'EnqueueChapters';
    const ids = intIds(chapterIds, op).map(String);
    return this.mutateQueue(op, ids, options, async () => {
      const [queue, states] = await Promise.all([
        this.getQueue(options),
        this.getChapterStates(ids, options),
      ]);
      const done = new Set([
        ...queue.items
          .filter((item) => item.state !== 'ERROR')
          .map((item) => item.chapterId),
        ...states
          .filter((state) => state.isDownloaded)
          .map((state) => state.id),
      ]);
      return ids.every((id) => done.has(id));
    });
  }

  async dequeueChapters(
    chapterIds: readonly string[],
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiMutationResult> {
    const op = 'DequeueChapters';
    const ids = intIds(chapterIds, op).map(String);
    return this.mutateQueue(op, ids, options, async () => {
      const queued = new Set(
        (await this.getQueue(options)).items.map((item) => item.chapterId)
      );
      return ids.every((id) => !queued.has(id));
    });
  }

  async startDownloader(
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiMutationResult> {
    return this.mutateQueue(
      'StartDownloader',
      undefined,
      options,
      async () => (await this.getQueue(options)).state === 'STARTED'
    );
  }

  /** A zero length means the chapter is not downloaded (`NOT_DOWNLOADED`). */
  async headChapterArchive(
    chapterId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiArchiveInfo> {
    const route = 'ChapterArchiveHead';
    const limit = this.#limits.chapterArchiveBytes;
    try {
      const path = `api/v1/chapter/${intId(chapterId, route)}/download`;
      const response = await this.sendBytes(
        'HEAD',
        path,
        limit,
        options.signal
      );
      return this.checkBytes(route, response, limit, true);
    } catch (error) {
      throw reportSuwayomiError(toSuwayomiError(error, route));
    }
  }

  /**
   * Streams a chapter CBZ without buffering it. Destroying the returned
   * stream, or aborting `signal`, cancels the upstream transfer.
   */
  async streamChapterArchive(
    chapterId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiByteStream> {
    const route = 'ChapterArchive';
    const path = `api/v1/chapter/${intId(chapterId, route)}/download`;
    return this.openStream(
      route,
      path,
      this.#limits.chapterArchiveBytes,
      options,
      true
    );
  }

  async streamMangaThumbnail(
    mangaId: string,
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiByteStream> {
    const route = 'MangaThumbnail';
    const path = `api/v1/manga/${intId(mangaId, route)}/thumbnail`;
    return this.openStream(
      route,
      path,
      this.#limits.thumbnailBytes,
      options,
      false
    );
  }

  private warnAboutMode(mode: string): void {
    // A diagnostic client must not use up the once-per-server warning.
    if (!this.#warnInsecureAuthMode) {
      return;
    }
    const key = `${mode} ${this.#origin}`;
    if ((mode !== 'NONE' && mode !== 'BASIC_AUTH') || warnedModes.has(key)) {
      return;
    }
    warnedModes.add(key);
    logger.warn(
      mode === 'NONE'
        ? 'Suwayomi authentication is disabled: anyone who can reach the server controls it. Enable UI login in Suwayomi.'
        : 'Suwayomi uses Basic authentication, which sends the credentials with every request. Prefer UI login.',
      { label: 'Suwayomi' }
    );
  }

  private async authorization(
    level: SuwayomiAuthLevel,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (level === 'none') return undefined;
    if (this.#basicAuthorization) return this.#basicAuthorization;
    if (level === 'public' || !this.#tokens) return undefined;
    return `${BEARER}${await this.#tokens.getAccessToken(signal)}`;
  }

  private async login(signal?: AbortSignal): Promise<SuwayomiTokens> {
    const { username, password } = this.#credentials ?? invalid('Login');
    const { data } = await this.postGraphQL(
      'Login',
      { username, password },
      undefined,
      {
        signal,
        interpretAs: 'UI_LOGIN',
      }
    );
    const payload = record(data.login, 'Login');
    return {
      accessToken: jwt(payload.accessToken, 'Login'),
      refreshToken: jwt(payload.refreshToken, 'Login'),
    };
  }

  private async refresh(refreshToken: string): Promise<string> {
    const { data } = await this.postGraphQL(
      'Refresh',
      { refreshToken },
      undefined,
      {
        interpretAs: 'UI_LOGIN',
      }
    );
    return jwt(record(data.refreshToken, 'Refresh').accessToken, 'Refresh');
  }

  /** One GraphQL round trip with an explicit Authorization header. */
  private async postGraphQL(
    name: SuwayomiOperationName,
    variables: Record<string, unknown> | undefined,
    authorization: string | undefined,
    options: PostOptions = {}
  ): Promise<GraphQLResult> {
    const operation = SUWAYOMI_OPERATIONS[name];
    const timeout = this.#timeouts[operation.callClass];
    // axios's own timeout stops counting once the headers arrive; this
    // deadline also bounds a body that stalls or trickles in.
    const deadline = AbortSignal.timeout(timeout);
    let response: AxiosResponse<unknown>;
    try {
      response = await this.request<unknown>(
        'POST',
        GRAPHQL_PATH,
        {
          operationName: name,
          query: operation.document,
          variables: variables ?? {},
        },
        {
          headers: authorization ? { Authorization: authorization } : {},
          signal: options.signal
            ? AbortSignal.any([options.signal, deadline])
            : deadline,
          timeout,
          validateStatus: () => true,
        }
      );
    } catch (error) {
      if (deadline.aborted && !options.signal?.aborted) {
        throw new SuwayomiError('TIMEOUT', name);
      }
      throw toSuwayomiError(error, name);
    }
    return interpretGraphQLResponse(
      name,
      response,
      options.interpretAs ?? this.authMode,
      options.allowPartial
    );
  }

  /** Sends with configured auth and renews an access token once on rejection. */
  private async execute(
    name: SuwayomiOperationName,
    variables: Record<string, unknown> | undefined,
    options: PostOptions
  ): Promise<GraphQLResult> {
    const { auth } = SUWAYOMI_OPERATIONS[name];
    try {
      const authorization = await this.authorization(auth, options.signal);
      try {
        return await this.postGraphQL(name, variables, authorization, options);
      } catch (error) {
        if (
          !this.#tokens ||
          auth !== 'user' ||
          failureCode(error) !== 'AUTH_REQUIRED'
        ) {
          throw error;
        }
        const token = await this.#tokens.renew(
          authorization?.slice(BEARER.length),
          options.signal
        );
        return await this.postGraphQL(
          name,
          variables,
          `${BEARER}${token}`,
          options
        );
      }
    } catch (error) {
      throw reportSuwayomiError(toSuwayomiError(error, name));
    }
  }

  private async run<T>(
    name: SuwayomiOperationName,
    variables: Record<string, unknown> | undefined,
    options: SuwayomiCallOptions,
    map: (data: Record<string, unknown>, result: GraphQLResult) => T,
    allowPartial = false
  ): Promise<T> {
    const result = await this.execute(name, variables, {
      signal: options.signal,
      allowPartial,
    });
    try {
      return map(result.data, result);
    } catch (error) {
      throw reportSuwayomiError(toSuwayomiError(error, name));
    }
  }

  private async listChapters(
    op: 'ChaptersToDownload' | 'DownloadedChapters',
    mangaId: string,
    options: SuwayomiCallOptions
  ): Promise<SuwayomiChapter[]> {
    return this.run(op, { mangaId: intId(mangaId, op) }, options, (data) =>
      nodes(data.chapters, op).map((node) => mapChapter(node, op))
    );
  }

  private async updateCategories(
    op: 'AddMangaToCategory' | 'RemoveMangaFromCategory',
    mangaId: string,
    categoryId: string,
    options: SuwayomiCallOptions
  ): Promise<void> {
    const variables = {
      id: intId(mangaId, op),
      categoryId: intId(categoryId, op, 1),
    };
    await this.run(op, variables, options, (data) =>
      record(data.updateMangaCategories, op)
    );
  }

  /** Deleting a key that no longer exists counts as success. */
  private async deleteMeta(
    op: 'DeleteRequestStamp' | 'DeleteRequestIndex',
    variables: Record<string, unknown>,
    options: SuwayomiCallOptions
  ): Promise<void> {
    try {
      await this.run(op, variables, options, () => undefined);
    } catch (error) {
      if (failureCode(error) !== 'NOT_FOUND') throw error;
    }
  }

  /**
   * Runs a queue mutation. A timeout, dropped connection or server-side error
   * is re-read before it counts as a failure, because the mutation may still
   * have applied.
   */
  private async mutateQueue(
    op: 'EnqueueChapters' | 'DequeueChapters' | 'StartDownloader',
    ids: string[] | undefined,
    options: SuwayomiCallOptions,
    applied: () => Promise<boolean>
  ): Promise<SuwayomiMutationResult> {
    try {
      await this.run(
        op,
        ids && { ids: ids.map(Number) },
        options,
        () => undefined
      );
      return { confirmedBy: 'response' };
    } catch (error) {
      const failure = toSuwayomiError(error, op);
      if (!READBACK_CODES.has(failure.code)) throw failure;
      for (let attempt = 0; attempt < this.#readback.attempts; attempt += 1) {
        try {
          await sleep(this.#readback.delayMs, undefined, {
            signal: options.signal,
          });
          if (await applied()) {
            logger.debug('Suwayomi mutation confirmed by readback', {
              label: 'Suwayomi',
              operation: op,
              code: failure.code,
            });
            return { confirmedBy: 'readback' };
          }
        } catch (readError) {
          const readFailure = toSuwayomiError(readError, op);
          if (readFailure.code === 'ABORTED') throw readFailure;
        }
      }
      throw failure;
    }
  }

  private async sendBytes(
    method: 'HEAD' | 'GET',
    path: string,
    limit: number,
    signal: AbortSignal | undefined
  ): Promise<AxiosResponse<unknown>> {
    const send = (authorization: string | undefined) =>
      this.request<unknown>(method, path, undefined, {
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        signal,
        timeout:
          method === 'HEAD' ? this.#timeouts.query : this.#timeouts.bytes,
        validateStatus: () => true,
        decompress: false,
        // Axios enforces this on streams too; limitStream is the guarantee.
        maxContentLength: limit,
        ...(method === 'GET' ? { responseType: 'stream' as const } : {}),
      });

    // UI_LOGIN byte routes accept only the access token, never Basic.
    const authorization = await this.authorization('user', signal);
    const response = await send(authorization);
    if (response.status !== 401 || !this.#tokens) {
      return response;
    }
    discard(response.data);
    const token = await this.#tokens.renew(
      authorization?.slice(BEARER.length),
      signal
    );
    return send(`${BEARER}${token}`);
  }

  private checkBytes(
    route: string,
    response: AxiosResponse<unknown>,
    limit: number,
    archive: boolean
  ): SuwayomiArchiveInfo {
    const { status, headers } = response;
    const fail = (code: SuwayomiErrorCode): never => {
      throw new SuwayomiError(code, route, { httpStatus: status });
    };
    const authCode = authStatusCode(status, this.authMode, headers);
    if (authCode) fail(authCode);
    if (status === 404) fail('NOT_FOUND');
    // Suwayomi answers GET with 400 when the chapter is not downloaded.
    if (archive && status === 400) fail('NOT_DOWNLOADED');
    if (status !== 200) fail('HTTP_ERROR');

    const length = readHeader(headers, 'content-length');
    const contentLength =
      length !== undefined && /^\d{1,16}$/.test(length)
        ? Number(length)
        : undefined;
    // ...and HEAD with 200 and an empty body.
    if (contentLength === 0) fail(archive ? 'NOT_DOWNLOADED' : 'BAD_RESPONSE');
    if (contentLength !== undefined && contentLength > limit) {
      fail('RESPONSE_TOO_LARGE');
    }
    const contentType = mediaType(readHeader(headers, 'content-type'));
    if (!archive && !contentType?.startsWith('image/')) fail('BAD_RESPONSE');
    return { contentLength, contentType };
  }

  private async openStream(
    route: string,
    path: string,
    limit: number,
    options: SuwayomiCallOptions,
    archive: boolean
  ): Promise<SuwayomiByteStream> {
    // A local controller lets a consumer that stops reading cancel the
    // request even when upstream is stalled and the stream is idle.
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let body: Readable | undefined;
    try {
      const response = await this.sendBytes('GET', path, limit, signal);
      body = response.data instanceof Readable ? response.data : undefined;
      // Axios reports an abort as an 'error' event on the response stream,
      // which would crash the process without a listener.
      body?.on('error', () => undefined);
      const info = this.checkBytes(route, response, limit, archive);
      return {
        ...info,
        stream: limitStream(
          route,
          body ?? badResponse(route),
          limit,
          controller
        ),
      };
    } catch (error) {
      body?.destroy();
      controller.abort();
      throw reportSuwayomiError(toSuwayomiError(error, route));
    }
  }
}

const invalidPayload = (
  partial: boolean,
  operation: string,
  errorCount: number
): never => {
  throw new SuwayomiError(
    partial ? 'UPSTREAM_ERROR' : 'BAD_RESPONSE',
    operation,
    {
      errorCount: partial ? errorCount : undefined,
    }
  );
};

const discard = (data: unknown): void => {
  if (data instanceof Readable) {
    data.on('error', () => undefined);
    data.destroy();
  }
};

/** Copies `body` with backpressure and fails once more than `limit` bytes arrive. */
const limitStream = (
  route: string,
  body: Readable,
  limit: number,
  controller: AbortController
): Readable => {
  let received = 0;
  const output = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > limit) {
        callback(
          reportSuwayomiError(new SuwayomiError('RESPONSE_TOO_LARGE', route))
        );
        return;
      }
      callback(null, chunk);
    },
  });
  output.once('close', () => {
    if (!body.readableEnded) {
      controller.abort();
      body.destroy();
    }
  });
  body.on('error', (error) => {
    output.destroy(reportSuwayomiError(toSuwayomiError(error, route)));
  });
  body.pipe(output);
  return output;
};

export default SuwayomiAPI;

import { SuwayomiError, isRecord } from '@server/api/suwayomi/errors';
import type {
  SuwayomiAvailability,
  SuwayomiCategory,
  SuwayomiChapter,
  SuwayomiChapterRelease,
  SuwayomiChapterState,
  SuwayomiHealth,
  SuwayomiLibraryItem,
  SuwayomiMangaChapterStates,
  SuwayomiMangaDetails,
  SuwayomiMangaKey,
  SuwayomiMangaSummary,
  SuwayomiMangaTrackRecords,
  SuwayomiQueue,
  SuwayomiSource,
} from '@server/api/suwayomi/types';

// Responses are validated field by field; nothing upstream is trusted as typed.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
export const HAS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS_EXCEPT_NEWLINE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const MANGA_STATUSES = [
  'UNKNOWN',
  'ONGOING',
  'COMPLETED',
  'LICENSED',
  'PUBLISHING_FINISHED',
  'CANCELLED',
  'ON_HIATUS',
] as const;
const DOWNLOADER_STATES = ['STARTED', 'STOPPED'] as const;
const QUEUE_STATES = ['QUEUED', 'DOWNLOADING', 'FINISHED', 'ERROR'] as const;
const META_PREFIX = 'seerrng.';
const MAX_INT = 2_147_483_647;

export const META_KEY_LIMIT = 256;
export const META_VALUE_LIMIT = 4_096;

export const badResponse = (operation: string): never => {
  throw new SuwayomiError('BAD_RESPONSE', operation);
};

export const record = (
  value: unknown,
  operation: string
): Record<string, unknown> =>
  isRecord(value) ? value : badResponse(operation);

export const list = (value: unknown, operation: string): unknown[] =>
  Array.isArray(value) ? value : badResponse(operation);

export const nodes = (value: unknown, operation: string): unknown[] =>
  list(isRecord(value) ? value.nodes : undefined, operation);

/** IDs stay strings: `Int` IDs arrive as numbers, `LongString` IDs as digits. */
export const toIdString = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === 'string' && /^\d{1,19}$/.test(value)
    ? value
    : undefined;
};

const id = (value: unknown, operation: string): string =>
  toIdString(value) ?? badResponse(operation);

export const text = (value: unknown, max = 512): string | undefined =>
  typeof value === 'string'
    ? value.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, max) || undefined
    : undefined;

const multilineText = (value: unknown, max: number): string | undefined =>
  typeof value === 'string'
    ? value
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL_CHARACTERS_EXCEPT_NEWLINE, '')
        .trim()
        .slice(0, max) || undefined
    : undefined;

/** Natural-key URLs must round-trip unchanged, so they are checked, not cleaned. */
const sourceUrl = (value: unknown, operation: string): string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 2_048 &&
  !HAS_CONTROL_CHARACTER.test(value)
    ? value
    : badResponse(operation);

const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** Epoch timestamps as digit strings; zero means "never". */
const timestamp = (value: unknown): string | undefined => {
  const digits = toIdString(value);
  return digits && !/^0+$/.test(digits) ? digits : undefined;
};

const oneOf = <T extends string, F extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: F
): T | F => allowed.find((item) => item === value) ?? fallback;

const totalCount = (value: unknown): number =>
  (isRecord(value) ? int(value.totalCount) : undefined) ?? 0;

/** Library scan counts decide availability, so they are never defaulted. */
const count = (value: unknown, operation: string): number => {
  const parsed = int(value);
  return parsed !== undefined && parsed >= 0 ? parsed : badResponse(operation);
};

const flag = (value: unknown, operation: string): boolean =>
  typeof value === 'boolean' ? value : badResponse(operation);

/** Like `text`, but counts code points, so a surrogate pair is never split. */
const codePointText = (value: unknown, max: number): string =>
  Array.from(text(value, max * 2) ?? '')
    .slice(0, max)
    .join('')
    .trim();

export const sanitizeVersion = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[\w.+-]{1,64}$/.test(value)
    ? value
    : undefined;

/** Keeps only this application's meta keys. */
const seerrngMeta = (value: unknown): Record<string, string> => {
  const meta: Record<string, string> = {};
  for (const entry of Array.isArray(value) ? value : []) {
    if (
      isRecord(entry) &&
      typeof entry.key === 'string' &&
      typeof entry.value === 'string' &&
      entry.key.startsWith(META_PREFIX) &&
      entry.key.length <= META_KEY_LIMIT &&
      entry.value.length <= META_VALUE_LIMIT
    ) {
      meta[entry.key] = entry.value;
    }
  }
  return meta;
};

export const mapMangaSummary = (
  value: unknown,
  operation: string
): SuwayomiMangaSummary => {
  const raw = record(value, operation);
  return {
    id: id(raw.id, operation),
    sourceId: id(raw.sourceId, operation),
    url: sourceUrl(raw.url, operation),
    title: text(raw.title) ?? '',
    author: text(raw.author),
    status: oneOf(raw.status, MANGA_STATUSES, 'UNKNOWN'),
    inLibrary: raw.inLibrary === true,
    initialized: raw.initialized === true,
  };
};

export const mapMangaDetails = (
  value: unknown,
  operation: string
): SuwayomiMangaDetails => {
  const raw = record(value, operation);
  return {
    ...mapMangaSummary(raw, operation),
    artist: text(raw.artist),
    description: multilineText(raw.description, 10_000),
    genre: (Array.isArray(raw.genre) ? raw.genre : [])
      .map((genre) => text(genre, 64))
      .filter((genre): genre is string => genre !== undefined)
      .slice(0, 50),
    inLibraryAt: timestamp(raw.inLibraryAt),
    lastFetchedAt: timestamp(raw.lastFetchedAt),
    chaptersLastFetchedAt: timestamp(raw.chaptersLastFetchedAt),
    downloadCount: int(raw.downloadCount) ?? 0,
    unreadCount: int(raw.unreadCount) ?? 0,
    hasDuplicateChapters: raw.hasDuplicateChapters === true,
    chapterCount: totalCount(raw.chapters),
    meta: seerrngMeta(raw.meta),
  };
};

export const mapAvailability = (
  value: unknown,
  operation: string
): SuwayomiAvailability => {
  const raw = record(value, operation);
  return {
    id: id(raw.id, operation),
    inLibrary: raw.inLibrary === true,
    status: oneOf(raw.status, MANGA_STATUSES, 'UNKNOWN'),
    downloadCount: int(raw.downloadCount) ?? 0,
    hasDuplicateChapters: raw.hasDuplicateChapters === true,
    chaptersLastFetchedAt: timestamp(raw.chaptersLastFetchedAt),
    chapterCount: totalCount(raw.chapters),
  };
};

export const mapChapterState = (
  value: unknown,
  operation: string
): SuwayomiChapterState => {
  const raw = record(value, operation);
  return {
    id: id(raw.id, operation),
    mangaId: id(raw.mangaId, operation),
    isDownloaded: raw.isDownloaded === true,
  };
};

/**
 * A library listing entry. `url` is left out when it cannot be stored (over
 * 2,048 characters or with control characters); an empty URL or an invalid
 * ID fails the listing.
 */
export const mapLibraryItem = (
  value: unknown,
  operation: string
): Omit<SuwayomiLibraryItem, 'url'> & { url?: string } => {
  const raw = record(value, operation);
  const mangaId = id(raw.id, operation);
  const url =
    typeof raw.url === 'string' && raw.url !== ''
      ? raw.url
      : badResponse(operation);
  return {
    id: Number(mangaId) <= MAX_INT ? mangaId : badResponse(operation),
    sourceId: id(raw.sourceId, operation),
    url:
      url.length <= 2_048 && !HAS_CONTROL_CHARACTER.test(url) ? url : undefined,
    title: codePointText(raw.title, 512),
    downloadCount: count(raw.downloadCount, operation),
    chapterCount: count(record(raw.chapters, operation).totalCount, operation),
    hasDuplicateChapters: flag(raw.hasDuplicateChapters, operation),
  };
};

export const mapMangaTrackRecords = (
  value: unknown,
  operation: string
): SuwayomiMangaTrackRecords => {
  const raw = record(value, operation);
  return {
    mangaId: id(raw.id, operation),
    records: nodes(raw.trackRecords, operation).map((node) => {
      const entry = record(node, operation);
      return {
        trackerId: count(entry.trackerId, operation),
        remoteId: id(entry.remoteId, operation),
      };
    }),
  };
};

export const mapMangaChapterStates = (
  value: unknown,
  operation: string
): SuwayomiMangaChapterStates => {
  const raw = record(value, operation);
  const chapters = record(raw.chapters, operation);
  return {
    mangaId: id(raw.id, operation),
    totalCount: count(chapters.totalCount, operation),
    chapters: nodes(chapters, operation).map((node) => {
      const chapter = record(node, operation);
      return {
        chapterNumber: finite(chapter.chapterNumber) ?? badResponse(operation),
        isDownloaded: flag(chapter.isDownloaded, operation),
      };
    }),
  };
};

/** A natural key; a URL that cannot be stored is left out, not rejected. */
export const mapMangaKey = (
  value: unknown,
  operation: string
): SuwayomiMangaKey => {
  const raw = record(value, operation);
  const url = raw.url;
  return {
    id: id(raw.id, operation),
    sourceId: id(raw.sourceId, operation),
    url:
      typeof url === 'string' &&
      url !== '' &&
      url.length <= 2_048 &&
      !HAS_CONTROL_CHARACTER.test(url)
        ? url
        : undefined,
  };
};

/**
 * A stored chapter dated by its upload date (epoch milliseconds) or, for an
 * undated one, by when Suwayomi stored it (epoch seconds). Undefined when the
 * row lacks the date its list is filtered on.
 */
export const mapChapterRelease = (
  value: unknown,
  operation: string,
  undated: boolean
): SuwayomiChapterRelease | undefined => {
  const raw = record(value, operation);
  const uploadDate = timestamp(raw.uploadDate);
  const fetchedAt = timestamp(raw.fetchedAt);
  const releasedAt = undated
    ? uploadDate === undefined && fetchedAt !== undefined
      ? Number(fetchedAt) * 1_000
      : undefined
    : uploadDate !== undefined
      ? Number(uploadDate)
      : undefined;
  const release = {
    id: id(raw.id, operation),
    mangaId: id(raw.mangaId, operation),
    chapterNumber: finite(raw.chapterNumber) ?? -1,
    isDownloaded: flag(raw.isDownloaded, operation),
  };
  return releasedAt === undefined ? undefined : { ...release, releasedAt };
};

export const mapChapter = (
  value: unknown,
  operation: string
): SuwayomiChapter => {
  const raw = record(value, operation);
  const pageCount = int(raw.pageCount);
  return {
    ...mapChapterState(raw, operation),
    url: sourceUrl(raw.url, operation),
    name: text(raw.name) ?? '',
    chapterNumber: finite(raw.chapterNumber) ?? -1,
    scanlator: text(raw.scanlator, 256),
    uploadDate: timestamp(raw.uploadDate),
    sourceOrder: int(raw.sourceOrder) ?? 0,
    pageCount:
      pageCount !== undefined && pageCount >= 0 ? pageCount : undefined,
  };
};

export const mapQueue = (value: unknown, operation: string): SuwayomiQueue => {
  const raw = record(value, operation);
  return {
    state: oneOf(raw.state, DOWNLOADER_STATES, 'UNKNOWN'),
    items: list(raw.queue, operation).map((item) => {
      const entry = record(item, operation);
      const chapter = record(entry.chapter, operation);
      return {
        chapterId: id(chapter.id, operation),
        mangaId: id(chapter.mangaId, operation),
        state: oneOf(entry.state, QUEUE_STATES, 'UNKNOWN'),
        progress: finite(entry.progress),
        tries: int(entry.tries),
      };
    }),
  };
};

export const mapCategory = (
  value: unknown,
  operation: string
): SuwayomiCategory => {
  const raw = record(value, operation);
  return {
    id: id(raw.id, operation),
    name: text(raw.name, 256) ?? '',
    includeInUpdate: text(raw.includeInUpdate, 16),
    includeInDownload: text(raw.includeInDownload, 16),
  };
};

export const mapSource = (
  value: unknown,
  operation: string
): SuwayomiSource => {
  const raw = record(value, operation);
  const extension = isRecord(raw.extension) ? raw.extension : {};
  return {
    id: id(raw.id, operation),
    name: text(raw.name, 256) ?? '',
    displayName: text(raw.displayName, 256) ?? '',
    lang: text(raw.lang, 32) ?? '',
    contentWarning: oneOf(
      raw.contentWarning,
      ['SAFE', 'MIXED', 'NSFW'] as const,
      'UNKNOWN'
    ),
    supportsLatest: raw.supportsLatest === true,
    hasUpdate: extension.hasUpdate === true,
    isObsolete: extension.isObsolete === true,
  };
};

export const mapHealth = (
  data: Record<string, unknown>,
  operation: string
): SuwayomiHealth => {
  const status = record(data.downloadStatus, operation);
  const queue = list(status.queue, operation);
  const settings = isRecord(data.settings) ? data.settings : {};
  const sourceTotal = isRecord(data.sources)
    ? (int(data.sources.totalCount) ?? 0)
    : 0;
  const queueErrors = queue.filter(
    (item) => isRecord(item) && item.state === 'ERROR'
  ).length;
  const health: SuwayomiHealth = {
    version: sanitizeVersion(
      isRecord(data.aboutServer) ? data.aboutServer.version : undefined
    ),
    downloaderState: oneOf(status.state, DOWNLOADER_STATES, 'UNKNOWN'),
    queueLength: queue.length,
    queueErrors,
    // The built-in local source is always present.
    sourceCount: Math.max(0, sourceTotal - 1),
    settings: {
      downloadAsCbz: bool(settings.downloadAsCbz),
      autoDownloadNewChapters: bool(settings.autoDownloadNewChapters),
      excludeEntryWithUnreadChapters: bool(
        settings.excludeEntryWithUnreadChapters
      ),
      excludeUnreadChapters: bool(settings.excludeUnreadChapters),
      excludeNotStarted: bool(settings.excludeNotStarted),
      globalUpdateInterval: finite(settings.globalUpdateInterval),
      maxSourcesInParallel: int(settings.maxSourcesInParallel),
      flareSolverrEnabled: bool(settings.flareSolverrEnabled),
    },
    warnings: [],
  };
  if (health.settings.downloadAsCbz === false) {
    health.warnings.push('CBZ_DISABLED');
  }
  if (sourceTotal <= 1) {
    health.warnings.push('NO_SOURCES');
  }
  if (queueErrors > 0) {
    health.warnings.push('QUEUE_ERRORS');
  }
  return health;
};

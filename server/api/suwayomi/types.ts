import type { Readable } from 'node:stream';

/**
 * Credentials stay in memory. `UI_LOGIN` exchanges them for short-lived
 * tokens; `BASIC_AUTH` sends them on every request.
 */
export type SuwayomiAuthConfig =
  | { mode: 'UI_LOGIN' | 'BASIC_AUTH'; username: string; password: string }
  | { mode: 'NONE' };

export type SuwayomiAuthMode = SuwayomiAuthConfig['mode'];

export type SuwayomiCallClass =
  'query' | 'mutation' | 'queue' | 'source' | 'bytes';

export type SuwayomiTimeouts = Record<SuwayomiCallClass, number>;

export interface SuwayomiAPIOptions {
  url: string;
  auth: SuwayomiAuthConfig;
  /** Milliseconds per call class; `bytes` also bounds each wait for body data. */
  timeouts?: Partial<SuwayomiTimeouts>;
  limits?: { chapterArchiveBytes?: number; thumbnailBytes?: number };
  /** Read state back after a queue mutation times out before failing it. */
  readback?: { attempts?: number; delayMs?: number };
  /**
   * Log the once-per-server warning about the NONE and BASIC_AUTH modes.
   * Defaults to true. Set it to false for short-lived diagnostic clients,
   * such as a settings connection test, so that they neither log the
   * warning nor stop the long-lived client for that server from logging it.
   */
  warnInsecureAuthMode?: boolean;
}

export interface SuwayomiCallOptions {
  signal?: AbortSignal;
}

export type SuwayomiDetectedAuthMode =
  'NONE' | 'BASIC_AUTH' | 'UI_LOGIN' | 'SIMPLE_LOGIN' | 'LOGIN_REQUIRED';

export type SuwayomiAuthWarning =
  'AUTH_DISABLED' | 'BASIC_AUTH_IN_USE' | 'MODE_MISMATCH' | 'EMPTY_CREDENTIALS';

export interface SuwayomiAuthDetection {
  mode: SuwayomiDetectedAuthMode;
  supported: boolean;
  authenticated: boolean;
  matchesConfigured: boolean;
  warnings: SuwayomiAuthWarning[];
}

export type SuwayomiCapabilityWarning =
  | 'BELOW_PINNED_REVISION'
  | 'PER_USER_SCHEMA'
  | 'INTROSPECTION_UNAVAILABLE'
  | 'UNKNOWN_VERSION';

export interface SuwayomiCapabilities {
  version?: string;
  revision?: number;
  buildType?: string;
  supported: boolean;
  /** Root fields this client needs that the server does not expose. */
  missingFields: string[];
  /** `fetchMangaAndChapters` returns stale data with `errors` on failure. */
  partialFetchResults: boolean;
  /** The schema exposes per-user state (for example `user.isDownloaded`). */
  perUserDownloadState: boolean;
  warnings: SuwayomiCapabilityWarning[];
}

export type SuwayomiHealthWarning =
  'CBZ_DISABLED' | 'NO_SOURCES' | 'QUEUE_ERRORS';

export interface SuwayomiHealth {
  version?: string;
  downloaderState: SuwayomiDownloaderState;
  queueLength: number;
  queueErrors: number;
  /** Installed sources, excluding the built-in local source. */
  sourceCount: number;
  settings: {
    downloadAsCbz?: boolean;
    autoDownloadNewChapters?: boolean;
    excludeEntryWithUnreadChapters?: boolean;
    excludeUnreadChapters?: boolean;
    excludeNotStarted?: boolean;
    globalUpdateInterval?: number;
    maxSourcesInParallel?: number;
    flareSolverrEnabled?: boolean;
  };
  warnings: SuwayomiHealthWarning[];
}

export type SuwayomiContentWarning = 'SAFE' | 'MIXED' | 'NSFW' | 'UNKNOWN';

export interface SuwayomiSource {
  id: string;
  name: string;
  displayName: string;
  lang: string;
  contentWarning: SuwayomiContentWarning;
  supportsLatest: boolean;
  hasUpdate: boolean;
  isObsolete: boolean;
}

export type SuwayomiMangaStatus =
  | 'UNKNOWN'
  | 'ONGOING'
  | 'COMPLETED'
  | 'LICENSED'
  | 'PUBLISHING_FINISHED'
  | 'CANCELLED'
  | 'ON_HIATUS';

export interface SuwayomiMangaSummary {
  id: string;
  sourceId: string;
  url: string;
  title: string;
  author?: string;
  status: SuwayomiMangaStatus;
  inLibrary: boolean;
  initialized: boolean;
}

export interface SuwayomiMangaDetails extends SuwayomiMangaSummary {
  artist?: string;
  description?: string;
  genre: string[];
  inLibraryAt?: string;
  lastFetchedAt?: string;
  chaptersLastFetchedAt?: string;
  downloadCount: number;
  unreadCount: number;
  hasDuplicateChapters: boolean;
  chapterCount: number;
  /** Only `seerrng.*` keys; other clients' meta is dropped. */
  meta: Record<string, string>;
}

export interface SuwayomiAvailability {
  id: string;
  inLibrary: boolean;
  status: SuwayomiMangaStatus;
  downloadCount: number;
  hasDuplicateChapters: boolean;
  chaptersLastFetchedAt?: string;
  chapterCount: number;
}

export interface SuwayomiAvailabilitySnapshot {
  mangas: SuwayomiAvailability[];
  queue: SuwayomiQueue;
}

export interface SuwayomiChapter {
  id: string;
  mangaId: string;
  url: string;
  name: string;
  chapterNumber: number;
  scanlator?: string;
  uploadDate?: string;
  sourceOrder: number;
  pageCount?: number;
  isDownloaded: boolean;
}

export interface SuwayomiChapterState {
  id: string;
  mangaId: string;
  isDownloaded: boolean;
}

export type SuwayomiDownloaderState = 'STARTED' | 'STOPPED' | 'UNKNOWN';

export interface SuwayomiQueueItem {
  chapterId: string;
  mangaId: string;
  state: 'QUEUED' | 'DOWNLOADING' | 'FINISHED' | 'ERROR' | 'UNKNOWN';
  progress?: number;
  tries?: number;
}

export interface SuwayomiQueue {
  state: SuwayomiDownloaderState;
  items: SuwayomiQueueItem[];
}

export interface SuwayomiCategory {
  id: string;
  name: string;
  includeInUpdate?: string;
  includeInDownload?: string;
}

export interface SuwayomiSearchPage {
  hasNextPage: boolean;
  mangas: SuwayomiMangaSummary[];
}

export interface SuwayomiFetchResult {
  /** False when Suwayomi reported a failure or the call timed out. */
  fresh: boolean;
  issue?: 'UPSTREAM_ERROR' | 'TIMEOUT';
  /**
   * After a timeout this is a readback of the stored manga; compare its
   * `chaptersLastFetchedAt` with an earlier value to see whether the fetch
   * completed on the server.
   */
  manga?: SuwayomiMangaDetails;
  /** Absent after a timeout, or when Suwayomi returned no chapter list. */
  chapters?: SuwayomiChapter[];
}

export interface SuwayomiMutationResult {
  /** `readback` means the call timed out but a re-read confirmed it. */
  confirmedBy: 'response' | 'readback';
}

export interface SuwayomiRequestIndexEntry {
  requestId: string;
  value: string;
}

export interface SuwayomiArchiveInfo {
  /** Absent when Suwayomi sends no length (for example a chunked body). */
  contentLength?: number;
  contentType?: string;
}

export interface SuwayomiByteStream extends SuwayomiArchiveInfo {
  /**
   * Fails with `RESPONSE_TOO_LARGE` once more bytes than the limit arrive, and
   * with `TIMEOUT` when Suwayomi sends nothing for `timeouts.bytes` while the
   * stream waits for data.
   */
  stream: Readable;
}

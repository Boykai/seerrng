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
  timeouts?: Partial<SuwayomiTimeouts>;
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

export type SuwayomiDownloaderState = 'STARTED' | 'STOPPED' | 'UNKNOWN';

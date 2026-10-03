import type {
  SuwayomiContentWarning,
  SuwayomiDetectedAuthMode,
  SuwayomiDownloaderState,
} from '@server/api/suwayomi/types';
import type { SuwayomiSettingsAuthMode } from '@server/lib/settings';

/**
 * A stored Suwayomi instance as the settings API returns it. `password` is
 * `[REDACTED]` when one is stored and `''` when not; the stored value is never
 * returned.
 */
export interface SuwayomiSettingsView {
  id: number;
  name: string;
  hostname: string;
  port: number;
  useSsl: boolean;
  baseUrl: string;
  isDefault: boolean;
  authMode: SuwayomiSettingsAuthMode;
  username: string;
  password: string;
  sourceAllowlist: string[];
  preferredLanguages: string[];
  scanlatorPreference: string[];
  requireCbz: boolean;
}

/**
 * Body for creating or updating an instance. The server assigns `id` and
 * `isDefault`. Sending `[REDACTED]` as the password keeps the stored one, but
 * only while the address and username are unchanged.
 */
export type SuwayomiSettingsRequest = Omit<
  SuwayomiSettingsView,
  'id' | 'isDefault' | 'baseUrl'
> & { baseUrl?: string };

/**
 * Body for a connection test. `id` lets `[REDACTED]` stand for the stored
 * password of that instance under the same rule as an update.
 */
export interface SuwayomiConnectionTestRequest {
  id?: number;
  hostname: string;
  port: number;
  useSsl?: boolean;
  baseUrl?: string;
  username?: string;
  password?: string;
  requireCbz?: boolean;
  sourceAllowlist?: string[];
}

export type SuwayomiSettingsErrorCode =
  | 'SUWAYOMI_INVALID_SETTINGS'
  | 'SUWAYOMI_CREDENTIALS_REQUIRED'
  | 'SUWAYOMI_PASSWORD_REQUIRED'
  | 'SUWAYOMI_INSTANCE_LIMIT'
  | 'SUWAYOMI_IN_USE';

export interface SuwayomiSettingsErrorResponse {
  code: SuwayomiSettingsErrorCode;
  message: string;
}

export type SuwayomiConnectionTestErrorCode =
  | 'SUWAYOMI_UNREACHABLE'
  | 'SUWAYOMI_TIMEOUT'
  | 'SUWAYOMI_NOT_SUWAYOMI'
  | 'SUWAYOMI_AUTH_FAILED'
  | 'SUWAYOMI_CREDENTIALS_REQUIRED'
  | 'SUWAYOMI_SIMPLE_LOGIN_UNSUPPORTED'
  | 'SUWAYOMI_UNSUPPORTED_SERVER'
  | 'SUWAYOMI_NO_SOURCES'
  | 'SUWAYOMI_CBZ_REQUIRED'
  | 'SUWAYOMI_UPSTREAM_ERROR';

export type SuwayomiConnectionTestWarningCode =
  | 'AUTH_DISABLED'
  | 'BASIC_AUTH_IN_USE'
  | 'EMPTY_CREDENTIALS'
  | 'CBZ_DISABLED'
  | 'QUEUE_ERRORS'
  | 'BELOW_PINNED_REVISION'
  | 'UNKNOWN_VERSION'
  | 'INTROSPECTION_UNAVAILABLE'
  | 'PER_USER_SCHEMA'
  | 'SOURCE_UPDATE_AVAILABLE'
  | 'SOURCE_OBSOLETE'
  | 'SOURCE_MISSING';

export interface SuwayomiConnectionTestWarning {
  code: SuwayomiConnectionTestWarningCode;
  /** Queue items in the error state, for QUEUE_ERRORS. */
  count?: number;
  /** Allowlisted sources the warning applies to, for the SOURCE_* codes. */
  sourceIds?: string[];
}

export interface SuwayomiConnectionTestSource {
  id: string;
  name: string;
  displayName: string;
  lang: string;
  contentWarning: SuwayomiContentWarning;
  hasUpdate: boolean;
  isObsolete: boolean;
}

export interface SuwayomiConnectionTestResult {
  success: true;
  /** The detected mode; save it as the instance's `authMode`. */
  authMode: SuwayomiSettingsAuthMode;
  version?: string;
  capabilities: {
    revision?: number;
    buildType?: string;
    supported: boolean;
    missingFields: string[];
  };
  health: {
    downloaderState: SuwayomiDownloaderState;
    queueLength: number;
    queueErrors: number;
    /** Installed sources, excluding the built-in local source. */
    sourceCount: number;
    downloadAsCbz?: boolean;
  };
  warnings: SuwayomiConnectionTestWarning[];
  /** Installed sources, excluding the built-in local source. */
  sources: SuwayomiConnectionTestSource[];
}

/** A test that reached a verdict other than success (HTTP 502). */
export interface SuwayomiConnectionTestFailure {
  success: false;
  code: SuwayomiConnectionTestErrorCode;
  message: string;
  /** Present once the authentication mode was detected. */
  authMode?: SuwayomiDetectedAuthMode;
  version?: string;
  /**
   * Present for SUWAYOMI_UNSUPPORTED_SERVER: the GraphQL fields SeerrNG needs
   * that the server lacks. Empty when the schema could not be read and the
   * version is older than v2.3.2223.
   */
  missingFields?: string[];
  warnings: SuwayomiConnectionTestWarning[];
}

export type SuwayomiConnectionTestResponse =
  SuwayomiConnectionTestResult | SuwayomiConnectionTestFailure;

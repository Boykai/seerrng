import { MediaRequestStatus } from '@server/constants/media';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Why following new chapters stopped or paused, stored in the manifest's
 * `followStopReason`; never free text. A stop turns following off; a pause
 * keeps it on and clears itself at the next check that finds nothing wrong.
 */
export enum MangaFollowStopReason {
  /** The owner no longer exists or may no longer request manga. */
  OWNER_NOT_PERMITTED = 'OWNER_NOT_PERMITTED',
  REQUEST_DECLINED = 'REQUEST_DECLINED',
  REQUEST_FAILED = 'REQUEST_FAILED',
  /** The source lists the end of a closed range, and it is requested. */
  RANGE_COMPLETE = 'RANGE_COMPLETE',
  /** The request holds the most chapters one request may. */
  MANIFEST_LIMIT = 'MANIFEST_LIMIT',
  /** Paused: the manga has no active binding on its server. */
  BINDING_INACTIVE = 'BINDING_INACTIVE',
  /** Paused: the request's Suwayomi server is no longer configured. */
  INSTANCE_MISSING = 'INSTANCE_MISSING',
  /** Paused: the active binding is another source manga. */
  BINDING_CHANGED = 'BINDING_CHANGED',
  /** Paused: Suwayomi no longer has the source manga. */
  MANGA_NOT_FOUND = 'MANGA_NOT_FOUND',
}

export const MANGA_FOLLOW_PAUSE_REASONS: ReadonlySet<string> = new Set([
  MangaFollowStopReason.BINDING_INACTIVE,
  MangaFollowStopReason.INSTANCE_MISSING,
  MangaFollowStopReason.BINDING_CHANGED,
  MangaFollowStopReason.MANGA_NOT_FOUND,
]);

/** Request statuses in which the owner may turn following on. */
export const MANGA_FOLLOW_ENABLE_STATUSES: readonly MediaRequestStatus[] = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.COMPLETED,
];

/** Checks one follow run makes on one Suwayomi instance. */
export const MANGA_FOLLOW_CHECKS_PER_INSTANCE = 20;
/** Checks one follow run makes against one source of an instance. */
export const MANGA_FOLLOW_CHECKS_PER_SOURCE = 5;
/** Chapters one check adds to a request; the rest come at the next check. */
export const MANGA_FOLLOW_ROWS_PER_CHECK = 100;
/** The most chapters following lets one request hold. */
export const MANGA_FOLLOW_MANIFEST_LIMIT = 10_000;
/** Requests whose following the run stops after a decline or failure. */
export const MANGA_FOLLOW_STOPS_PER_RUN = 100;

/** How long until the next check. */
export const MANGA_FOLLOW_WAIT_MS = {
  /** An ongoing manga, plus up to `jitter`. */
  ongoing: 8 * HOUR_MS,
  jitter: 4 * HOUR_MS,
  /** A manga on hiatus. */
  hiatus: 7 * DAY_MS,
  /** A finished manga whose requested chapters were all delivered. */
  finished: 30 * DAY_MS,
  /** After a chapter list that wasn't fresh, or a failed enqueue. */
  retry: HOUR_MS,
  /** While paused. */
  paused: DAY_MS,
} as const;

/** Which chapters a manga request asks for. */
export enum MangaRequestScope {
  /** Every chapter the source lists when the request is dispatched. */
  ALL_AT_DISPATCH = 'ALL_AT_DISPATCH',
  /** The chapters with the N highest chapter numbers. */
  LATEST_N = 'LATEST_N',
  /** The chapters numbered from `rangeStart` to `rangeEnd`, inclusive. */
  RANGE = 'RANGE',
}

/**
 * Whether the request's title has an ACTIVE source binding on its target
 * instance. A hint kept in step with the bindings; dispatch re-verifies it.
 */
export enum MangaRequestBindingState {
  /** Parked: no ACTIVE binding exists yet on the target instance. */
  AWAITING_BINDING = 'AWAITING_BINDING',
  BOUND = 'BOUND',
}

/** Dispatch steps, in order. Each names the last step completed. */
export enum MangaRequestCheckpoint {
  BINDING_VERIFIED = 'BINDING_VERIFIED',
  INSTANCE_MARKED = 'INSTANCE_MARKED',
  LIBRARY_ADDED = 'LIBRARY_ADDED',
  CATEGORY_READY = 'CATEGORY_READY',
  CHAPTERS_FETCHED = 'CHAPTERS_FETCHED',
  MANIFEST_FROZEN = 'MANIFEST_FROZEN',
  CHAPTERS_ENQUEUED = 'CHAPTERS_ENQUEUED',
}

/** The stable codes a manifest's `lastError` carries; never free text. */
export enum MangaDispatchError {
  /** No ACTIVE binding, or Suwayomi no longer has the bound item. */
  BINDING_MISSING = 'MANGA_BINDING_MISSING',
  /** Only bindings below HIGH confidence that no admin confirmed. */
  BINDING_UNCONFIRMED = 'MANGA_BINDING_UNCONFIRMED',
  /** The target instance is no longer configured, or its settings are unusable. */
  INSTANCE_MISSING = 'MANGA_INSTANCE_MISSING',
  /** The server carries another instance's marker; nothing is written. */
  INSTANCE_MISMATCH = 'MANGA_INSTANCE_MISMATCH',
  /** The instance's address or login changed during the dispatch. */
  INSTANCE_CHANGED = 'MANGA_INSTANCE_CHANGED',
  SUWAYOMI_UNAVAILABLE = 'MANGA_SUWAYOMI_UNAVAILABLE',
  SUWAYOMI_AUTH = 'MANGA_SUWAYOMI_AUTH',
  SUWAYOMI_UNSUPPORTED = 'MANGA_SUWAYOMI_UNSUPPORTED',
  SUWAYOMI_ERROR = 'MANGA_SUWAYOMI_ERROR',
  /** The source answered the chapter fetch with an error. */
  SOURCE_FETCH_FAILED = 'MANGA_SOURCE_FETCH_FAILED',
  /** The chapter fetch kept failing; retried on a slower schedule. */
  SOURCE_UNAVAILABLE = 'MANGA_SOURCE_UNAVAILABLE',
  /** The request's scope matched no chapter the source lists yet. */
  NO_MATCHING_CHAPTERS = 'MANGA_NO_MATCHING_CHAPTERS',
  DISPATCH_ERROR = 'MANGA_DISPATCH_ERROR',
}

const HOUR_MS = 60 * 60 * 1_000;

/** How long dispatch waits before the sweep retries, per reason. */
export const MANGA_DISPATCH_WAIT_MS = {
  /** A missing or mismatched instance, auth, an unsupported server, others. */
  attention: 6 * HOUR_MS,
  /**
   * A binding no admin confirmed yet, or a frozen request whose binding went
   * away; an admin or a scan may resolve either.
   */
  binding: HOUR_MS,
  noMatchingChapters: 24 * HOUR_MS,
} as const;

/** Consecutive failed chapter fetches before the slower schedule starts. */
export const MANGA_SOURCE_FETCH_ATTEMPTS = 5;

/** The Suwayomi category every requested manga joins. */
export const MANGA_DISPATCH_CATEGORY = 'SeerrNG';

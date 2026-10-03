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

/**
 * Why an enqueued request needs someone to look at it. The progress poll
 * owns these; dispatch keeps `lastError`. A code never fails, completes or
 * re-dispatches a request by itself, and clears when its cause does.
 */
export enum MangaAttentionCode {
  /** Suwayomi's queue holds one of the request's chapters in ERROR. */
  CHAPTER_ERROR = 'MANGA_CHAPTER_ERROR',
  /** A chapter is neither downloaded, queued nor in error on two polls. */
  CHAPTER_NOT_QUEUED = 'MANGA_CHAPTER_NOT_QUEUED',
  /** The source no longer lists a chapter, a day after it went. */
  CHAPTER_MISSING = 'MANGA_CHAPTER_MISSING',
  /** Suwayomi says a chapter is downloaded, but its file is empty twice. */
  CHAPTER_FILE_MISSING = 'MANGA_CHAPTER_FILE_MISSING',
  /** A downloaded chapter's file came without a size, so it never verifies. */
  CHAPTER_LENGTH_UNKNOWN = 'MANGA_CHAPTER_LENGTH_UNKNOWN',
  /** The bound manga left the Suwayomi library. */
  NOT_IN_LIBRARY = 'MANGA_NOT_IN_LIBRARY',
  /** The request's Suwayomi server is no longer configured. */
  INSTANCE_REMOVED = 'MANGA_INSTANCE_REMOVED',
  /** The bound manga no longer resolves, or its binding went away. */
  BINDING_ORPHANED = 'MANGA_BINDING_ORPHANED',
}

/** The state a chapter row was last seen in, as the progress poll records it. */
export enum MangaChapterQueueState {
  QUEUED = 'QUEUED',
  DOWNLOADING = 'DOWNLOADING',
  ERROR = 'ERROR',
  /** Suwayomi lists it as downloaded. */
  DOWNLOADED = 'DOWNLOADED',
  /** Not downloaded and not in the queue. */
  NOT_QUEUED = 'NOT_QUEUED',
  /** No current chapter matches the row. */
  UNMAPPED = 'UNMAPPED',
}

/** What the last HEAD found when it could not verify a chapter's file. */
export enum MangaChapterFileState {
  /** One HEAD found no file. */
  EMPTY = 'EMPTY',
  /** HEADs on two or more polls found no file. */
  MISSING = 'MISSING',
  /** The answer carried no file size. */
  NO_LENGTH = 'NO_LENGTH',
}

/** Manifests one progress poll looks at, least recently polled first. */
export const MANGA_PROGRESS_MANIFESTS_PER_RUN = 200;
/** Chapter files one progress poll checks on one instance. */
export const MANGA_PROGRESS_HEADS_PER_INSTANCE = 50;
/** How long a chapter may vanish from its source before it counts as missing. */
export const MANGA_CHAPTER_MISSING_GRACE_MS = 24 * HOUR_MS;
/**
 * How long the poll waits before it checks a file again: a verified chapter
 * Suwayomi stopped listing as downloaded, or one whose file was empty or came
 * without a size.
 */
export const MANGA_PROGRESS_RECHECK_MS = HOUR_MS / 2;

/** The Suwayomi category every requested manga joins. */
export const MANGA_DISPATCH_CATEGORY = 'SeerrNG';

import type { SuwayomiErrorCode } from '@server/api/suwayomi/errors';
import type { MangaBindingConfidence } from '@server/entity/MangaSourceBinding';
import type { MangaResolutionStatus } from '@server/entity/MangaSourceResolution';
import type { PaginatedResponse } from '@server/interfaces/api/common';
import type { MangaLibraryBinding } from '@server/interfaces/api/mangaLibraryInterfaces';

export type MangaResolveErrorCode =
  | 'MANGA_INVALID_REQUEST'
  | 'MANGA_SOURCE_NOT_ALLOWED'
  | 'MANGA_RESOLVE_TITLE_NOT_FOUND'
  | 'MANGA_INSTANCE_NOT_FOUND'
  | 'MANGA_CANDIDATE_NOT_FOUND'
  | 'MANGA_ITEM_NOT_FOUND'
  | 'MANGA_ALREADY_BOUND'
  | 'MANGA_CANDIDATE_GONE'
  | 'MANGA_ITEM_BOUND_ELSEWHERE'
  | 'MANGA_UNSUPPORTED_SERVER'
  | 'MANGA_INSTANCE_CHANGED'
  | 'MANGA_ITEM_CHANGED'
  | 'MANGA_UNIQUE_CONFLICT'
  | 'MANGA_SUWAYOMI_LOOKUP_FAILED';

export interface MangaResolveErrorResponse {
  code: MangaResolveErrorCode;
  message: string;
  /** Why the Suwayomi lookup failed; only with MANGA_SUWAYOMI_LOOKUP_FAILED. */
  suwayomiCode?: SuwayomiErrorCode;
}

/** A title no run has searched yet waits for approval or for the job. */
export type MangaResolveListStatus =
  MangaResolutionStatus | 'AWAITING_APPROVAL';

/** Why a title has its status. */
export type MangaResolveReason =
  // BOUND
  | 'EXACT_LINK'
  | 'EXISTING_BINDING'
  | 'ADMIN_BIND'
  // NEEDS_PICK
  | 'MANGADEX_AMBIGUOUS'
  | 'EXACT_IN_LIBRARY'
  | 'EXACT_BOUND_ELSEWHERE'
  | 'EXACT_REJECTED'
  | 'EXACT_NOT_PREFERRED'
  | 'EXACT_BY_TITLE'
  | 'TITLE_MATCHES'
  // NO_MATCH
  | 'NO_CANDIDATES'
  | 'NO_ELIGIBLE_SOURCES'
  | 'MANGADEX_FAILED'
  // EXCLUDED
  | 'CONTENT_POLICY'
  | 'ANILIST_NOT_FOUND';

/** What went wrong in a title's last run. */
export type MangaResolveFailure =
  | 'ANILIST_FAILED'
  | 'ANILIST_RATE_LIMITED'
  | 'MANGADEX_COOLDOWN'
  | 'MANGADEX_FAILED'
  | 'SOURCE_SEARCH_FAILED'
  | 'SUWAYOMI_UNAVAILABLE'
  | 'BIND_FAILED';

/** A requested title that waits for a source binding on one instance. */
export interface MangaResolveTitle {
  anilistId: number;
  instanceId: number;
  status: MangaResolveListStatus;
  reason: MangaResolveReason | null;
  /**
   * The MangaDex manga whose AniList link names the title; the first of
   * several with MANGADEX_AMBIGUOUS.
   */
  mangadexUuid: string | null;
  /** Whether an approved request waits; only an admin search sends others. */
  approved: boolean;
  /** The oldest waiting request on the title. */
  requestId: number;
  candidateCount: number;
  attempts: number;
  checkedAt: string | null;
  searchedAt: string | null;
  nextAttemptAt: string | null;
  searchRequestedAt: string | null;
  /** A failure in the last run, never upstream text. */
  lastError: MangaResolveFailure | null;
}

export interface MangaResolveTitlesResponse extends PaginatedResponse {
  results: MangaResolveTitle[];
}

/** A source manga found for the title. `url` is source-relative. */
export interface MangaResolveCandidate {
  id: number;
  sourceId: string;
  /** The source's name and language as Suwayomi listed them at the search. */
  sourceName: string;
  sourceLang: string;
  url: string;
  suwayomiMangaId: number;
  title: string;
  inLibrary: boolean;
  /** Title similarity from 0 to 1; 1 for an exact link. */
  score: number;
  confidence:
    | MangaBindingConfidence.EXACT_LINK
    | MangaBindingConfidence.HIGH
    | MangaBindingConfidence.MEDIUM
    | MangaBindingConfidence.LOW;
  /** `mangadex-link` for an exact link, else `title`. */
  matchedBy: string;
  createdAt: string;
}

export interface MangaResolveDetail extends MangaResolveTitle {
  candidates: MangaResolveCandidate[];
  /** The title's live bindings on the instance. */
  bindings: MangaLibraryBinding[];
}

export interface MangaResolveSearchResponse {
  title: MangaResolveTitle;
  /** False when a run is already going; the next run takes the title. */
  runStarted: boolean;
}

export interface MangaResolveBindResponse {
  /** `unchanged` when the item was already bound to the title. */
  outcome: 'bound' | 'unchanged';
  binding: MangaLibraryBinding;
  title: MangaResolveTitle;
}

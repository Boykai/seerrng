import type { SuwayomiErrorCode } from '@server/api/suwayomi/errors';
import type { MediaStatus } from '@server/constants/media';
import type {
  MangaBindingConfidence,
  MangaBindingState,
} from '@server/entity/MangaSourceBinding';
import type { PaginatedResponse } from '@server/interfaces/api/common';

export type MangaLibraryErrorCode =
  | 'MANGA_INVALID_REQUEST'
  | 'MANGA_INSTANCE_NOT_FOUND'
  | 'MANGA_CANDIDATE_NOT_FOUND'
  | 'MANGA_ITEM_NOT_FOUND'
  | 'MANGA_PROPOSAL_CHANGED'
  | 'MANGA_NOT_IN_LIBRARY'
  | 'MANGA_UNSUPPORTED_SERVER'
  | 'MANGA_INSTANCE_CHANGED'
  | 'MANGA_ITEM_CHANGED'
  | 'MANGA_UNIQUE_CONFLICT'
  | 'MANGA_SUWAYOMI_LOOKUP_FAILED';

export interface MangaLibraryErrorResponse {
  code: MangaLibraryErrorCode;
  message: string;
  /** Why the Suwayomi lookup failed; only with MANGA_SUWAYOMI_LOOKUP_FAILED. */
  suwayomiCode?: SuwayomiErrorCode;
}

/** A title match waiting for an admin; never bound automatically. */
export interface MangaLibraryProposal {
  anilistId: number;
  confidence:
    | MangaBindingConfidence.HIGH
    | MangaBindingConfidence.MEDIUM
    | MangaBindingConfidence.LOW;
  /** Title similarity, from 0 to 1. */
  score: number;
}

/** An in-library item with no live binding. `url` is source-relative. */
export interface MangaLibraryCandidate {
  id: number;
  instanceId: number;
  suwayomiMangaId: number;
  sourceId: string;
  url: string;
  title: string;
  proposal: MangaLibraryProposal | null;
  updatedAt: string;
}

export interface MangaLibraryBinding {
  id: number;
  instanceId: number;
  sourceId: string;
  url: string;
  suwayomiMangaId: number | null;
  title: string | null;
  anilistId: number;
  confidence: MangaBindingConfidence;
  matchedBy: string;
  origin: string;
  state: MangaBindingState;
  inLibrary: boolean;
  availability: MediaStatus;
  chapterCount: number | null;
  downloadCount: number | null;
  updatedAt: string;
}

/** One library item after a review decision. */
export interface MangaLibraryItemState {
  /** The item's live binding, if any. */
  binding: MangaLibraryBinding | null;
  candidate: MangaLibraryCandidate | null;
}

export interface MangaLibraryCandidatesResponse extends PaginatedResponse {
  results: MangaLibraryCandidate[];
}

export interface MangaLibraryBindingsResponse extends PaginatedResponse {
  results: MangaLibraryBinding[];
}

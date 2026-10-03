import type { SuwayomiErrorCode } from '@server/api/suwayomi/errors';
import type { MangaResolveErrorCode } from '@server/interfaces/api/mangaResolveInterfaces';
import { MangaLibraryError } from '@server/lib/mangaLibraryReview';

const ERRORS: Record<MangaResolveErrorCode, [status: number, message: string]> =
  {
    MANGA_INVALID_REQUEST: [400, 'The request is invalid.'],
    MANGA_SOURCE_NOT_ALLOWED: [
      400,
      'The source is not on the instance allowlist.',
    ],
    MANGA_RESOLVE_TITLE_NOT_FOUND: [
      404,
      'No waiting manga request was found for the title.',
    ],
    MANGA_INSTANCE_NOT_FOUND: [404, 'The Suwayomi instance was not found.'],
    MANGA_CANDIDATE_NOT_FOUND: [404, 'The candidate was not found.'],
    MANGA_ITEM_NOT_FOUND: [404, 'Suwayomi does not know the manga.'],
    MANGA_ALREADY_BOUND: [409, 'The title is already bound on the instance.'],
    MANGA_CANDIDATE_GONE: [409, 'Suwayomi no longer has the candidate.'],
    MANGA_ITEM_BOUND_ELSEWHERE: [
      409,
      'The manga is bound to another title; review it in the library first.',
    ],
    MANGA_UNSUPPORTED_SERVER: [409, 'This Suwayomi server is not supported.'],
    MANGA_INSTANCE_CHANGED: [409, 'The Suwayomi instance has changed.'],
    MANGA_ITEM_CHANGED: [409, 'The manga has changed.'],
    MANGA_UNIQUE_CONFLICT: [409, 'A concurrent change to the manga won.'],
    MANGA_SUWAYOMI_LOOKUP_FAILED: [502, 'The Suwayomi lookup failed.'],
  };

/** A picker failure with a stable code and a fixed message. */
export class MangaResolveError extends Error {
  constructor(
    readonly code: MangaResolveErrorCode,
    readonly suwayomiCode?: SuwayomiErrorCode
  ) {
    super(ERRORS[code][1]);
    this.name = 'MangaResolveError';
  }

  get status(): number {
    return ERRORS[this.code][0];
  }
}

const LIBRARY_CODES: Partial<
  Record<MangaLibraryError['code'], MangaResolveErrorCode>
> = {
  MANGA_INVALID_REQUEST: 'MANGA_INVALID_REQUEST',
  MANGA_INSTANCE_NOT_FOUND: 'MANGA_INSTANCE_NOT_FOUND',
  MANGA_ITEM_NOT_FOUND: 'MANGA_ITEM_NOT_FOUND',
  MANGA_UNSUPPORTED_SERVER: 'MANGA_UNSUPPORTED_SERVER',
  MANGA_INSTANCE_CHANGED: 'MANGA_INSTANCE_CHANGED',
  MANGA_UNIQUE_CONFLICT: 'MANGA_UNIQUE_CONFLICT',
  MANGA_SUWAYOMI_LOOKUP_FAILED: 'MANGA_SUWAYOMI_LOOKUP_FAILED',
};

/** A library review failure as a picker failure; anything else unchanged. */
export const asMangaResolveError = (error: unknown): unknown =>
  error instanceof MangaLibraryError
    ? new MangaResolveError(
        LIBRARY_CODES[error.code] ?? 'MANGA_ITEM_CHANGED',
        error.suwayomiCode
      )
    : error;

import { MangaRequestScope } from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type {
  MangaRequestScopeSummary,
  MangaRequestScopeValue,
} from '@server/lib/mangaRequests';

// The server's limits (server/lib/mangaRequests.ts); a test keeps them equal.
export const MANGA_MAX_LATEST_COUNT = 10_000;
export const MANGA_MAX_CHAPTER_NUMBER = 1_000_000;

/** A request as the request endpoints return it, with the manga scope. */
export type MangaScopedRequest = NonFunctionProperties<MediaRequest> & {
  mangaScope?: MangaRequestScopeSummary | null;
};

/** The scope form's values, kept as typed so errors can name the field. */
export interface MangaScopeDraft {
  scope: MangaRequestScope;
  latestCount: string;
  rangeStart: string;
  rangeEnd: string;
}

/** The `mangaScope` request field: each scope with exactly its own fields. */
export type MangaScopeBody =
  | { scope: MangaRequestScope.ALL_AT_DISPATCH }
  | { scope: MangaRequestScope.LATEST_N; latestCount: number }
  | { scope: MangaRequestScope.RANGE; rangeStart: number; rangeEnd?: number };

export interface MangaScopeErrors {
  latestCount?: 'invalid';
  rangeStart?: 'invalid';
  rangeEnd?: 'invalid' | 'beforeStart';
}

const WHOLE_NUMBER = /^\d+$/;
const CHAPTER_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

const parseBounded = (
  value: string,
  pattern: RegExp,
  min: number,
  max: number
): number | undefined => {
  const text = value.trim();
  if (!pattern.test(text)) {
    return undefined;
  }
  const number = Number(text);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : undefined;
};

/** Validates a draft with the server's rules; `body` is set only if valid. */
export const parseMangaScopeDraft = (
  draft: MangaScopeDraft
): { body?: MangaScopeBody; errors: MangaScopeErrors } => {
  if (draft.scope === MangaRequestScope.LATEST_N) {
    const latestCount = parseBounded(
      draft.latestCount,
      WHOLE_NUMBER,
      1,
      MANGA_MAX_LATEST_COUNT
    );
    return latestCount === undefined
      ? { errors: { latestCount: 'invalid' } }
      : { body: { scope: draft.scope, latestCount }, errors: {} };
  }

  if (draft.scope === MangaRequestScope.RANGE) {
    const errors: MangaScopeErrors = {};
    const rangeStart = parseBounded(
      draft.rangeStart,
      CHAPTER_NUMBER,
      0,
      MANGA_MAX_CHAPTER_NUMBER
    );
    const hasEnd = draft.rangeEnd.trim() !== '';
    const rangeEnd = hasEnd
      ? parseBounded(
          draft.rangeEnd,
          CHAPTER_NUMBER,
          0,
          MANGA_MAX_CHAPTER_NUMBER
        )
      : undefined;
    if (rangeStart === undefined) {
      errors.rangeStart = 'invalid';
    }
    if (hasEnd && rangeEnd === undefined) {
      errors.rangeEnd = 'invalid';
    } else if (
      rangeStart !== undefined &&
      rangeEnd !== undefined &&
      rangeEnd < rangeStart
    ) {
      errors.rangeEnd = 'beforeStart';
    }
    if (rangeStart === undefined || errors.rangeEnd) {
      return { errors };
    }
    return {
      body: {
        scope: draft.scope,
        rangeStart,
        ...(rangeEnd !== undefined ? { rangeEnd } : {}),
      },
      errors,
    };
  }

  return { body: { scope: MangaRequestScope.ALL_AT_DISPATCH }, errors: {} };
};

const draftNumber = (value?: number | null): string =>
  value === null || value === undefined ? '' : String(value);

/** The form values for a stored scope; no scope means every chapter. */
export const draftFromMangaScope = (
  scope?: MangaRequestScopeValue | null
): MangaScopeDraft => ({
  scope: scope?.scope ?? MangaRequestScope.ALL_AT_DISPATCH,
  latestCount: draftNumber(scope?.latestCount),
  rangeStart: draftNumber(scope?.rangeStart),
  rangeEnd: draftNumber(scope?.rangeEnd),
});

/** An approved manga request parked until an administrator links a source. */
export const isAwaitingMangaSource = (
  request?: Pick<MangaScopedRequest, 'type' | 'status' | 'mangaScope'> | null
): boolean =>
  request?.type === MediaType.MANGA &&
  request.status === MediaRequestStatus.APPROVED &&
  request.mangaScope?.awaitingBinding === true;

/** The AniList ID of manga media, from its canonical identifier. */
export const getMangaAniListId = (
  media?: Pick<NonFunctionProperties<MediaRequest>['media'], 'identifiers'>
): number | undefined => {
  const value = media?.identifiers?.find(
    (identifier) => identifier.provider === 'anilist'
  )?.value;
  const id = value && WHOLE_NUMBER.test(value) ? Number(value) : undefined;
  return id !== undefined && Number.isSafeInteger(id) && id > 0
    ? id
    : undefined;
};

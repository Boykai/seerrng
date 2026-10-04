import type { MangaResolveListStatus } from '@server/interfaces/api/mangaResolveInterfaces';

export const RESOLVE_API = '/api/v1/manga/resolve';

const MAX_INT32 = 2_147_483_647;
const MAX_SOURCE_ID = BigInt('9223372036854775807');
const MAX_URL_LENGTH = 2_048;

/** The statuses the list filters by; a BOUND title leaves the list. */
export const LIST_STATUSES = [
  'AWAITING_APPROVAL',
  'QUEUED',
  'NEEDS_PICK',
  'NO_MATCH',
  'EXCLUDED',
] as const satisfies readonly `${MangaResolveListStatus}`[];

export type ListStatus = (typeof LIST_STATUSES)[number];

export const isListStatus = (value: unknown): value is ListStatus =>
  LIST_STATUSES.includes(value as ListStatus);

export const resolveListKey = (
  page: number,
  pageSize: number,
  status?: ListStatus
): string =>
  `${RESOLVE_API}?take=${pageSize}&skip=${(page - 1) * pageSize}${
    status ? `&status=${status}` : ''
  }`;

export const resolveDetailKey = (
  anilistId: number,
  instanceId: number
): string => `${RESOLVE_API}/${anilistId}?instanceId=${instanceId}`;

const isIntegerIn = (value: unknown, min: number): value is number =>
  Number.isInteger(value) &&
  (value as number) >= min &&
  (value as number) <= MAX_INT32;

export const isAnilistId = (value: unknown): value is number =>
  isIntegerIn(value, 1);

/** Instance IDs start at 0, so never test one for truthiness. */
export const isInstanceId = (value: unknown): value is number =>
  isIntegerIn(value, 0);

export const searchBody = (instanceId: number) => ({ instanceId });

export const selectBody = (instanceId: number, candidateId: number) => ({
  instanceId,
  candidateId,
});

export type BindBody =
  | { instanceId: number; suwayomiMangaId: number }
  | { instanceId: number; sourceId: string; url: string };

export type BindProblem = 'source' | 'url' | 'mangaId';

export type BindResult =
  | { body: BindBody; problem?: undefined }
  | { body?: undefined; problem: BindProblem };

export const isSourceId = (value: string): boolean =>
  /^\d{1,19}$/.test(value) && BigInt(value) <= MAX_SOURCE_ID;

// The server's HAS_CONTROL_CHARACTER: C0 and C1 controls and DEL.
// eslint-disable-next-line no-control-regex
export const HAS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** A source-relative URL, so not necessarily http or https. */
export const isSourceUrl = (value: string): boolean =>
  value.length >= 1 &&
  value.length <= MAX_URL_LENGTH &&
  !HAS_CONTROL_CHARACTER.test(value);

/** Checks a bind by source and URL as the server does; builds its body. */
export const bindBySource = (
  instanceId: number,
  sourceId: string,
  url: string
): BindResult => {
  const trimmedUrl = url.trim();
  if (!isSourceId(sourceId)) return { problem: 'source' };
  if (!isSourceUrl(trimmedUrl)) return { problem: 'url' };
  return { body: { instanceId, sourceId, url: trimmedUrl } };
};

/** Checks a bind by Suwayomi manga ID as the server does; builds its body. */
export const bindByMangaId = (
  instanceId: number,
  mangaId: string
): BindResult => {
  const trimmed = mangaId.trim();
  const suwayomiMangaId = /^\d{1,10}$/.test(trimmed) ? Number(trimmed) : 0;
  return isIntegerIn(suwayomiMangaId, 1)
    ? { body: { instanceId, suwayomiMangaId } }
    : { problem: 'mangaId' };
};

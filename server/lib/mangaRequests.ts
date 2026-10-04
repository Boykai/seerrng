import type AnilistAPI from '@server/api/anilist';
import {
  MangaRequestBindingState,
  MangaRequestCheckpoint,
  MangaRequestScope,
} from '@server/constants/mangaRequest';
import type MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import { hashMangaSourceUrl } from '@server/entity/MangaSourceBinding';
import {
  enqueueMangaRequestDispatch,
  syncMangaRequestBindings,
} from '@server/lib/mangaRequestBindings';
import type { SuwayomiSettings } from '@server/lib/settings';
import { chunk } from '@server/utils/chunk';
import { parsePositiveRouteId } from '@server/utils/routeId';
import { In, IsNull, type EntityManager } from 'typeorm';

/** The AniList ID is unknown, or the content policy excludes its title. */
export class MangaRequestNotFoundError extends Error {
  constructor() {
    super('Manga not found.');
  }
}

/** AniList could not answer; `failure` tells a rate limit from an outage. */
export class MangaCatalogUnavailableError extends Error {
  constructor(public readonly failure: unknown) {
    super('Unable to retrieve manga details.');
  }
}

/** A `mangaScope` the server refuses; the message says why. */
export class MangaRequestScopeError extends Error {}

export const MAX_MANGA_LATEST_COUNT = 10_000;
export const MAX_MANGA_CHAPTER_NUMBER = 1_000_000;
export const MAX_MANGA_CHAPTER_URL_LENGTH = 2048;
const MAX_SCANLATOR_LENGTH = 255;
const SUMMARY_SLICE = 500;

/** A request's chapter scope, as stored on its manifest. */
export interface MangaRequestScopeValue {
  scope: MangaRequestScope;
  latestCount: number | null;
  rangeStart: number | null;
  rangeEnd: number | null;
}

/** Following new chapters, as the request's manifest records it. */
export interface MangaRequestFollowSummary {
  enabled: boolean;
  /** Why following stopped (when off) or paused (when on); else null. */
  stopReason: string | null;
  lastCheckAt: Date | null;
  /** Null while following is on means the next run checks it. */
  nextCheckAt: Date | null;
}

/** The read-only scope summary request responses carry. */
export interface MangaRequestScopeSummary extends MangaRequestScopeValue {
  /** Parked until a library scan or an admin binds the title. */
  awaitingBinding: boolean;
  /**
   * Changed only through `PUT /request/{requestId}/follow`. Request
   * responses always carry it; it is optional so summaries built without
   * follow state, such as client test fixtures, stay valid.
   */
  follow?: MangaRequestFollowSummary;
}

export const DEFAULT_MANGA_REQUEST_SCOPE: MangaRequestScopeValue = {
  scope: MangaRequestScope.ALL_AT_DISPATCH,
  latestCount: null,
  rangeStart: null,
  rangeEnd: null,
};

/** A positive AniList ID from a request body, else undefined. */
export const parseMangaRequestId = (value: unknown): number | undefined =>
  parsePositiveRouteId(typeof value === 'string' ? value.trim() : value);

const SCOPE_FIELDS = new Set([
  'scope',
  'latestCount',
  'rangeStart',
  'rangeEnd',
]);

const isChapterNumber = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX_MANGA_CHAPTER_NUMBER;

/**
 * Validates a `mangaScope` request field. Absent means every chapter at
 * dispatch. Fields that don't belong to the chosen scope are refused, and so
 * are unknown keys; numbers must be JSON numbers.
 */
export const parseMangaRequestScope = (
  input: unknown
): { value: MangaRequestScopeValue } | { error: string } => {
  if (input === undefined || input === null) {
    return { value: { ...DEFAULT_MANGA_REQUEST_SCOPE } };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'mangaScope must be an object.' };
  }
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !SCOPE_FIELDS.has(key))) {
    return { error: 'mangaScope contains an unsupported field.' };
  }
  const scope = fields.scope ?? MangaRequestScope.ALL_AT_DISPATCH;
  if (!Object.values(MangaRequestScope).includes(scope as MangaRequestScope)) {
    return {
      error: 'mangaScope.scope must be ALL_AT_DISPATCH, LATEST_N or RANGE.',
    };
  }
  const present = (key: string) =>
    fields[key] !== undefined && fields[key] !== null;
  const foreign = (keys: string[]) => keys.some(present);

  if (scope === MangaRequestScope.LATEST_N) {
    if (foreign(['rangeStart', 'rangeEnd'])) {
      return { error: 'LATEST_N takes latestCount only.' };
    }
    const latestCount = fields.latestCount;
    if (
      typeof latestCount !== 'number' ||
      !Number.isSafeInteger(latestCount) ||
      latestCount < 1 ||
      latestCount > MAX_MANGA_LATEST_COUNT
    ) {
      return {
        error: `latestCount must be an integer from 1 to ${MAX_MANGA_LATEST_COUNT}.`,
      };
    }
    return {
      value: { ...DEFAULT_MANGA_REQUEST_SCOPE, scope, latestCount },
    };
  }

  if (scope === MangaRequestScope.RANGE) {
    if (foreign(['latestCount'])) {
      return { error: 'RANGE takes rangeStart and rangeEnd only.' };
    }
    if (!isChapterNumber(fields.rangeStart)) {
      return {
        error: `rangeStart must be a chapter number from 0 to ${MAX_MANGA_CHAPTER_NUMBER}.`,
      };
    }
    const rangeStart = fields.rangeStart;
    if (!present('rangeEnd')) {
      return {
        value: { ...DEFAULT_MANGA_REQUEST_SCOPE, scope, rangeStart },
      };
    }
    if (!isChapterNumber(fields.rangeEnd) || fields.rangeEnd < rangeStart) {
      return {
        error: `rangeEnd must be a chapter number from rangeStart to ${MAX_MANGA_CHAPTER_NUMBER}.`,
      };
    }
    return {
      value: {
        ...DEFAULT_MANGA_REQUEST_SCOPE,
        scope,
        rangeStart,
        rangeEnd: fields.rangeEnd,
      },
    };
  }

  if (foreign(['latestCount', 'rangeStart', 'rangeEnd'])) {
    return { error: 'ALL_AT_DISPATCH takes no chapter limits.' };
  }
  return { value: { ...DEFAULT_MANGA_REQUEST_SCOPE } };
};

/** The dispatch steps in order; a manifest's checkpoint names the last one done. */
export const MANGA_REQUEST_CHECKPOINTS: readonly MangaRequestCheckpoint[] = [
  MangaRequestCheckpoint.BINDING_VERIFIED,
  MangaRequestCheckpoint.INSTANCE_MARKED,
  MangaRequestCheckpoint.LIBRARY_ADDED,
  MangaRequestCheckpoint.CATEGORY_READY,
  MangaRequestCheckpoint.CHAPTERS_FETCHED,
  MangaRequestCheckpoint.MANIFEST_FROZEN,
  MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
];

/** The step after `current` (the first when null), or undefined after the last. */
export const getNextMangaRequestCheckpoint = (
  current: MangaRequestCheckpoint | null
): MangaRequestCheckpoint | undefined =>
  MANGA_REQUEST_CHECKPOINTS[
    current === null ? 0 : MANGA_REQUEST_CHECKPOINTS.indexOf(current) + 1
  ];

/**
 * Records the step after `expected`, only while the manifest still sits at
 * `expected`, so a second worker can't repeat or skip a step. Reaching
 * MANIFEST_FROZEN also freezes the scope. Returns whether the step was
 * recorded.
 */
export const advanceMangaRequestCheckpoint = async (
  manager: EntityManager,
  manifestId: number,
  expected: MangaRequestCheckpoint | null
): Promise<boolean> => {
  const next = getNextMangaRequestCheckpoint(expected);
  if (!next) {
    return false;
  }
  const result = await manager
    .createQueryBuilder()
    .update(MangaRequestManifest)
    .set({
      checkpoint: next,
      checkpointAt: () => 'CURRENT_TIMESTAMP',
      lastError: null,
      ...(next === MangaRequestCheckpoint.MANIFEST_FROZEN
        ? { frozenAt: () => 'CURRENT_TIMESTAMP' }
        : {}),
    })
    .where({
      id: manifestId,
      checkpoint: expected === null ? IsNull() : expected,
    })
    .execute();
  return result.affected === 1;
};

/** A chapter as a source lists it, for manifest selection. */
export interface MangaChapterCandidate {
  /** Source-relative URL: the chapter's key. */
  url: string;
  /** Unknown when null, non-finite or negative (Suwayomi reports -1). */
  chapterNumber: number | null;
  scanlator?: string | null;
  /** Epoch milliseconds. */
  uploadDate?: number | null;
}

export const isKnownMangaChapterNumber = (
  value: number | null | undefined
): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const normalizeScanlator = (value: string | null | undefined): string =>
  (value ?? '').trim().toLowerCase();

/**
 * Picks a manifest's chapters. Each known chapter number keeps one chapter in
 * every scope: the best-ranked scanlator in `scanlatorPreference` (compared
 * trimmed and case-insensitively; unlisted and missing ones last), then the
 * newest upload, then the smallest URL. LATEST_N counts distinct numbers;
 * RANGE is inclusive, open-ended when rangeEnd is null. Chapters with unknown
 * numbers are kept by ALL_AT_DISPATCH only. Known chapters come first in
 * number order, then unknown ones in input order, each URL once.
 */
export const selectMangaManifestChapters = <
  Chapter extends MangaChapterCandidate,
>(
  scope: MangaRequestScopeValue,
  chapters: readonly Chapter[],
  scanlatorPreference: readonly string[] = []
): Chapter[] => {
  const preference = new Map<string, number>();
  scanlatorPreference.forEach((name, index) => {
    const key = normalizeScanlator(name);
    if (key && !preference.has(key)) preference.set(key, index);
  });
  const rankOf = (chapter: Chapter) =>
    preference.get(normalizeScanlator(chapter.scanlator)) ?? Infinity;
  const uploadOf = (chapter: Chapter) =>
    typeof chapter.uploadDate === 'number' &&
    Number.isFinite(chapter.uploadDate)
      ? chapter.uploadDate
      : -Infinity;
  const isBetter = (candidate: Chapter, current: Chapter) => {
    if (rankOf(candidate) !== rankOf(current)) {
      return rankOf(candidate) < rankOf(current);
    }
    if (uploadOf(candidate) !== uploadOf(current)) {
      return uploadOf(candidate) > uploadOf(current);
    }
    return candidate.url < current.url;
  };

  const byNumber = new Map<number, Chapter>();
  const unknown: Chapter[] = [];
  for (const chapter of chapters) {
    if (!isKnownMangaChapterNumber(chapter.chapterNumber)) {
      unknown.push(chapter);
      continue;
    }
    const current = byNumber.get(chapter.chapterNumber);
    if (!current || isBetter(chapter, current)) {
      byNumber.set(chapter.chapterNumber, chapter);
    }
  }
  let selected = [...byNumber.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, chapter]) => chapter);

  if (scope.scope === MangaRequestScope.LATEST_N) {
    const count = scope.latestCount ?? 0;
    selected = count > 0 ? selected.slice(-count) : [];
  } else if (scope.scope === MangaRequestScope.RANGE) {
    const start = scope.rangeStart ?? 0;
    const end = scope.rangeEnd ?? Infinity;
    selected = selected.filter(
      ({ chapterNumber }) =>
        (chapterNumber as number) >= start && (chapterNumber as number) <= end
    );
  } else {
    selected = [...selected, ...unknown];
  }

  const seen = new Set<string>();
  return selected.filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
};

/** Unsaved chapter rows for a manifest; each URL once, invalid URLs skipped. */
export const buildMangaRequestChapterRows = (
  manifestId: number,
  chapters: readonly MangaChapterCandidate[]
): Pick<
  MangaRequestChapter,
  'manifestId' | 'url' | 'urlHash' | 'chapterNumber' | 'scanlator'
>[] => {
  const rows = new Map<
    string,
    Pick<
      MangaRequestChapter,
      'manifestId' | 'url' | 'urlHash' | 'chapterNumber' | 'scanlator'
    >
  >();
  for (const chapter of chapters) {
    if (
      typeof chapter.url !== 'string' ||
      chapter.url.length === 0 ||
      chapter.url.length > MAX_MANGA_CHAPTER_URL_LENGTH
    ) {
      continue;
    }
    const urlHash = hashMangaSourceUrl(chapter.url);
    if (rows.has(urlHash)) continue;
    let scanlator = (chapter.scanlator ?? '')
      .trim()
      .slice(0, MAX_SCANLATOR_LENGTH);
    if (/[\uD800-\uDBFF]$/.test(scanlator)) scanlator = scanlator.slice(0, -1);
    rows.set(urlHash, {
      manifestId,
      url: chapter.url,
      urlHash,
      chapterNumber: isKnownMangaChapterNumber(chapter.chapterNumber)
        ? chapter.chapterNumber
        : null,
      scanlator: scanlator || null,
    });
  }
  return [...rows.values()];
};

/**
 * The instance a manga request targets: the given one, else the default
 * instance, else the first. Undefined when none matches.
 */
export const selectMangaRequestInstance = (
  instances: readonly SuwayomiSettings[],
  serverId?: number | null
): SuwayomiSettings | undefined =>
  serverId != null
    ? instances.find(({ id }) => id === serverId)
    : (instances.find(({ isDefault }) => isDefault) ?? instances[0]);

const importMangaRequestPolicy = () =>
  Promise.all([
    import('@server/api/anilist'),
    import('@server/api/anilist/manga'),
    import('@server/lib/mangaCatalog'),
  ]);

let mangaRequestPolicyModules:
  ReturnType<typeof importMangaRequestPolicy> | undefined;

/**
 * Loads the AniList client, its manga helpers and the catalog policy once
 * and keeps them. They load on first use so that importers of the request
 * entity skip the client's HTML sanitizer and the catalog's import cycle.
 * The server calls this at boot, before Next starts: under `pnpm dev`, Next
 * removes ts-node's `.ts` loader once it has loaded next.config.ts, and a
 * `.ts` module that has not loaded by then no longer resolves.
 */
export const loadMangaRequestPolicy = (): ReturnType<
  typeof importMangaRequestPolicy
> => {
  mangaRequestPolicyModules ??= importMangaRequestPolicy().catch(
    (error: unknown) => {
      mangaRequestPolicyModules = undefined;
      throw error;
    }
  );
  return mangaRequestPolicyModules;
};

/**
 * Refuses an AniList ID that is unknown or excluded by the content policy
 * (adult titles, novels) with one indistinguishable error. Runs before any
 * row is written; uses the shared AniList client, limiter and cache.
 */
export const assertMangaRequestable = async (
  anilistId: number
): Promise<void> => {
  const [
    { default: AnilistClient },
    { isAnilistMangaExcluded },
    { getMangaContentPolicy },
  ] = await loadMangaRequestPolicy();
  let details: Awaited<ReturnType<AnilistAPI['getMangaDetails']>>;
  try {
    details = await new AnilistClient().getMangaDetails(anilistId);
  } catch (error) {
    throw new MangaCatalogUnavailableError(error);
  }
  if (!details || isAnilistMangaExcluded(details, getMangaContentPolicy())) {
    throw new MangaRequestNotFoundError();
  }
};

/** A PENDING manga request edit: its target instance and, optionally, scope. */
export interface MangaRequestManifestEdit {
  instanceId: number;
  scope?: MangaRequestScopeValue;
}

/**
 * Moves an unfrozen manifest to `edit` and recomputes its binding state.
 * Returns false when the request has no manifest or its scope is frozen.
 */
export const updateMangaRequestManifest = async (
  manager: EntityManager,
  requestId: number,
  edit: MangaRequestManifestEdit
): Promise<boolean> => {
  const manifest = await manager.findOne(MangaRequestManifest, {
    select: { id: true, anilistId: true },
    where: { requestId, frozenAt: IsNull() },
  });
  if (!manifest) {
    return false;
  }
  const result = await manager.update(
    MangaRequestManifest,
    { id: manifest.id, frozenAt: IsNull() },
    { instanceId: edit.instanceId, ...edit.scope }
  );
  if (result.affected !== 1) {
    return false;
  }
  await enqueueMangaRequestDispatch(
    await syncMangaRequestBindings(manager, [manifest.anilistId]),
    manager
  );
  return true;
};

export const toMangaRequestScopeSummary = (
  manifest: Pick<
    MangaRequestManifest,
    | 'scope'
    | 'latestCount'
    | 'rangeStart'
    | 'rangeEnd'
    | 'bindingState'
    | 'followEnabled'
    | 'followStopReason'
    | 'followLastAt'
    | 'followNextAt'
  >
): MangaRequestScopeSummary => ({
  scope: manifest.scope,
  latestCount: manifest.latestCount ?? null,
  rangeStart: manifest.rangeStart ?? null,
  rangeEnd: manifest.rangeEnd ?? null,
  awaitingBinding: manifest.bindingState !== MangaRequestBindingState.BOUND,
  follow: {
    enabled: manifest.followEnabled === true,
    stopReason: manifest.followStopReason ?? null,
    lastCheckAt: manifest.followLastAt ?? null,
    nextCheckAt: manifest.followNextAt ?? null,
  },
});

/** Scope summaries by request ID, loaded in one query per 500 requests. */
export const loadMangaRequestScopeSummaries = async (
  manager: EntityManager,
  requestIds: readonly number[]
): Promise<Map<number, MangaRequestScopeSummary>> => {
  const summaries = new Map<number, MangaRequestScopeSummary>();
  for (const slice of chunk([...new Set(requestIds)], SUMMARY_SLICE)) {
    const manifests = await manager.find(MangaRequestManifest, {
      select: {
        id: true,
        requestId: true,
        scope: true,
        latestCount: true,
        rangeStart: true,
        rangeEnd: true,
        bindingState: true,
        followEnabled: true,
        followStopReason: true,
        followLastAt: true,
        followNextAt: true,
      },
      where: { requestId: In(slice) },
    });
    for (const manifest of manifests) {
      summaries.set(manifest.requestId, toMangaRequestScopeSummary(manifest));
    }
  }
  return summaries;
};

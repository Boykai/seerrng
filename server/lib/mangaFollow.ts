import AnilistAPI from '@server/api/anilist';
import type { AnilistMangaStatus } from '@server/api/anilist/manga';
import type SuwayomiAPI from '@server/api/suwayomi';
import {
  SuwayomiError,
  type SuwayomiErrorCode,
} from '@server/api/suwayomi/errors';
import type {
  SuwayomiChapter,
  SuwayomiFetchResult,
  SuwayomiMangaStatus,
} from '@server/api/suwayomi/types';
import {
  MANGA_FOLLOW_CHECKS_PER_INSTANCE,
  MANGA_FOLLOW_CHECKS_PER_SOURCE,
  MANGA_FOLLOW_MANIFEST_LIMIT,
  MANGA_FOLLOW_ROWS_PER_CHECK,
  MANGA_FOLLOW_STOPS_PER_RUN,
  MANGA_FOLLOW_WAIT_MS,
  MangaFollowStopReason,
} from '@server/constants/mangaFollow';
import {
  MangaRequestBindingState,
  MangaRequestCheckpoint,
  MangaRequestScope,
} from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaInstanceMarker from '@server/entity/MangaInstanceMarker';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import {
  MediaRequest,
  getRequestMutationAdmissionKey,
  hasMediaRequestPermission,
  runWithRequestAdmission,
} from '@server/entity/MediaRequest';
import MediaRequestStatusEvent from '@server/entity/MediaRequestStatusEvent';
import { runWithMangaDispatchLock } from '@server/lib/mangaDispatch';
import {
  assertSameInstance,
  countRows,
  isSameManga,
} from '@server/lib/mangaProgress';
import {
  DEFAULT_MANGA_REQUEST_SCOPE,
  MAX_MANGA_CHAPTER_URL_LENGTH,
  buildMangaRequestChapterRows,
  isKnownMangaChapterNumber,
  selectMangaManifestChapters,
  type MangaChapterCandidate,
  type MangaRequestScopeValue,
} from '@server/lib/mangaRequests';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import { RequestStatusStage } from '@server/lib/requestStatus';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import {
  SuwayomiInstanceChangedError,
  snapshotSuwayomiInstance,
} from '@server/lib/suwayomi/instanceAdmission';
import logger from '@server/logger';
import { chunk } from '@server/utils/chunk';
import { AsyncLocalStorage } from 'node:async_hooks';
import { IsNull, Not, type EntityManager } from 'typeorm';

/*
 * Following new chapters: the owner's consent, stored on the manifest, to add
 * chapters the source publishes after dispatch froze the request's scope. Per
 * instance, one at a time, the job asks Suwayomi to refresh a due manga's
 * chapter list from its source (never its metadata), adds the chapters the
 * scope admits to the frozen manifest, re-opens a completed request, and
 * queues the new chapters the way dispatch does. This is the one write path
 * that adds rows to a frozen manifest: it deliberately bypasses
 * `updateMangaRequestManifest`, which refuses frozen manifests. It never
 * removes or dequeues a row, never changes media status, never starts the
 * downloader and never changes a Suwayomi setting.
 */

const LABEL = 'Manga Follow';
/** Chapter IDs per enqueue call, as dispatch sends them. */
const QUEUE_BATCH_SIZE = 50;
/** Chapter rows per insert. */
const INSERT_SLICE = 100;
const MAX_SUWAYOMI_INT = 2_147_483_647;
const REOPEN_MESSAGE = 'New chapters were added to this request.';

/** Failures that stop the checks of an instance, not just one manga. */
const STOP_CODES = new Set<SuwayomiErrorCode>([
  'UNREACHABLE',
  'TIMEOUT',
  'REQUEST_REFUSED',
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'AUTH_MODE_UNSUPPORTED',
  'AUTH_MODE_MISMATCH',
  'UNSUPPORTED_SERVER',
]);

/**
 * How Suwayomi fails a chapter refresh of a manga ID it no longer has: the
 * refresh mutation reports it as a plain GraphQL error.
 */
const RESOLVE_CODES = new Set<SuwayomiErrorCode>([
  'NOT_FOUND',
  'UPSTREAM_ERROR',
]);

export type MangaFollowClient = Pick<
  SuwayomiAPI,
  | 'fetchMangaAndChapters'
  | 'findMangaByNaturalKey'
  | 'getInstanceMarker'
  | 'getChaptersToDownload'
  | 'getDownloadedChapters'
  | 'getQueue'
  | 'enqueueChapters'
>;

export interface MangaFollowOptions {
  signal?: AbortSignal;
  /** Replaces the shared client factory; tests pass their own client. */
  clientFor?: (instanceId: number) => MangaFollowClient | undefined;
  /** AniList's publication status of a title; tests pass their own. */
  anilistStatus?: (
    anilistId: number
  ) => Promise<AnilistMangaStatus | undefined>;
  /** A number in [0, 1) that spreads the next checks; tests fix it. */
  random?: () => number;
  /** Bounds below the defaults, for tests. */
  limits?: {
    perInstance?: number;
    perSource?: number;
    stops?: number;
    rowsPerCheck?: number;
    manifestRows?: number;
  };
}

export interface MangaFollowCounts {
  /** Manifests whose fresh chapter list a check used. */
  checked: number;
  /** Chapter rows added to manifests. */
  added: number;
  /** Completed requests opened again for new chapters. */
  reopened: number;
  /** Manifests whose following turned off. */
  stopped: number;
  paused: number;
  /** Chapters handed to Suwayomi's download queue. */
  enqueued: number;
  instancesFailed: number;
}

interface Run {
  signal?: AbortSignal;
  clientFor: (instanceId: number) => MangaFollowClient | undefined;
  anilistStatus: (anilistId: number) => Promise<AnilistMangaStatus | undefined>;
  random: () => number;
  limits: Required<NonNullable<MangaFollowOptions['limits']>>;
  counts: MangaFollowCounts;
}

interface InstanceRun {
  run: Run;
  instanceId: number;
  snapshot: SuwayomiSettings;
  client: MangaFollowClient;
  /** Set once the server's marker matched on this run. */
  markerChecked: boolean;
}

/** One source manga of an instance: the dispatch lock's key. */
interface MangaKey {
  sourceId: string;
  urlHash: string;
}

type Settlement = {
  kind: 'stop' | 'pause';
  reason: MangaFollowStopReason;
};

type Verdict =
  | { kind: 'skip' }
  | (Settlement & { manifest: MangaRequestManifest })
  | {
      kind: 'check';
      manifest: MangaRequestManifest;
      request: MediaRequest;
      binding: MangaSourceBinding;
    };

/** What a check wrote, and what it left for the enqueue. */
interface Written {
  added: number;
  reopened: boolean;
  /** Followed chapters not delivered yet, on an approved request. */
  enqueue: boolean;
  /** A stop that waits until the enqueue went through. */
  stopAfter?: MangaFollowStopReason;
  stopped?: MangaFollowStopReason;
  nextAt: Date;
}

/** Rolls a write back when the manifest or request moved under it. */
class FollowMovedError extends Error {}

/** The server does not carry this instance's marker. */
class InstanceMismatchError extends Error {
  constructor() {
    super('The Suwayomi server does not carry this instance marker.');
    this.name = 'InstanceMismatchError';
  }
}

const followLockScope = new AsyncLocalStorage<true>();

/** Whether the caller runs while the follow job holds a dispatch lock. */
export const isInsideMangaFollowLock = (): boolean =>
  followLockScope.getStore() === true;

const withFollowLock = <Result>(
  instanceId: number,
  key: MangaKey,
  callback: () => Promise<Result>
): Promise<Result> =>
  runWithMangaDispatchLock(instanceId, key.sourceId, key.urlHash, () =>
    followLockScope.run(true, callback)
  );

const withRequestAdmission = <Result>(
  requestId: number,
  callback: () => Promise<Result>
): Promise<Result> =>
  runWithRequestAdmission(
    [getRequestMutationAdmissionKey(requestId)],
    callback
  );

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const errorDetails = (error: unknown): Record<string, unknown> =>
  error instanceof SuwayomiError
    ? { suwayomiCode: error.code, operation: error.operation }
    : error instanceof InstanceMismatchError
      ? { code: 'MANGA_FOLLOW_INSTANCE_MISMATCH' }
      : { errorName: error instanceof Error ? error.name : typeof error };

/** A failure after which nothing else on the instance would work either. */
const isStop = (run: Run, error: unknown): boolean =>
  error instanceof SuwayomiInstanceChangedError ||
  error instanceof InstanceMismatchError ||
  (error instanceof SuwayomiError &&
    (STOP_CODES.has(error.code) ||
      (error.code === 'ABORTED' && !run.signal?.aborted)));

/** A Suwayomi manga ID as the manifest stores it. */
const toStoredMangaId = (mangaId: string): number => {
  const value = Number(mangaId);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SUWAYOMI_INT) {
    throw new SuwayomiError('BAD_RESPONSE', 'ByNaturalKey');
  }
  return value;
};

const toChapterCandidate = (
  chapter: SuwayomiChapter
): MangaChapterCandidate => {
  const uploadDate =
    chapter.uploadDate === undefined ? NaN : Number(chapter.uploadDate);
  return {
    url: chapter.url,
    chapterNumber: chapter.chapterNumber,
    scanlator: chapter.scanlator ?? null,
    uploadDate: Number.isFinite(uploadDate) ? uploadDate : null,
  };
};

const isStorableUrl = (url: unknown): url is string =>
  typeof url === 'string' &&
  url.length > 0 &&
  url.length <= MAX_MANGA_CHAPTER_URL_LENGTH;

export interface MangaFollowSelection<Chapter> {
  /** The chapters to add, in number order. */
  add: Chapter[];
  /** Qualifying chapters left for a later check. */
  remaining: number;
  /** More chapters qualify than the manifest may hold. */
  limitReached: boolean;
  /** A closed range whose end the source lists, with all of it added. */
  rangeComplete: boolean;
}

/**
 * The chapters a check adds. A known number is covered when any row has it,
 * a missing one included; only known, uncovered numbers with a storable URL
 * not in the manifest qualify. ALL_AT_DISPATCH takes every one of them,
 * LATEST_N those above the highest number in the manifest, RANGE those
 * inside it (open-ended without an end). One chapter per number, picked as
 * dispatch picks them, at most `rowsPerCheck`, and never past `manifestRows`.
 */
export const selectMangaFollowChapters = <
  Chapter extends MangaChapterCandidate,
>({
  scope,
  rows,
  chapters,
  scanlatorPreference = [],
  rowsPerCheck = MANGA_FOLLOW_ROWS_PER_CHECK,
  manifestRows = MANGA_FOLLOW_MANIFEST_LIMIT,
}: {
  scope: MangaRequestScopeValue;
  rows: readonly Pick<MangaRequestChapter, 'chapterNumber' | 'urlHash'>[];
  chapters: readonly Chapter[];
  scanlatorPreference?: readonly string[];
  rowsPerCheck?: number;
  manifestRows?: number;
}): MangaFollowSelection<Chapter> => {
  const covered = new Set<number>();
  const hashes = new Set<string>();
  let highest = -Infinity;
  for (const row of rows) {
    hashes.add(row.urlHash);
    if (isKnownMangaChapterNumber(row.chapterNumber)) {
      covered.add(row.chapterNumber);
      highest = Math.max(highest, row.chapterNumber);
    }
  }
  const admits = (number: number): boolean => {
    switch (scope.scope) {
      case MangaRequestScope.LATEST_N:
        return number > highest;
      case MangaRequestScope.RANGE:
        return (
          number >= (scope.rangeStart ?? 0) &&
          (scope.rangeEnd === null || number <= scope.rangeEnd)
        );
      default:
        return true;
    }
  };
  const candidates = chapters.filter(
    (chapter) =>
      isKnownMangaChapterNumber(chapter.chapterNumber) &&
      isStorableUrl(chapter.url) &&
      !covered.has(chapter.chapterNumber) &&
      admits(chapter.chapterNumber) &&
      !hashes.has(hashMangaSourceUrl(chapter.url))
  );
  const picked = selectMangaManifestChapters(
    DEFAULT_MANGA_REQUEST_SCOPE,
    candidates,
    scanlatorPreference
  );
  const room = Math.max(0, manifestRows - rows.length);
  const add = picked.slice(0, Math.min(rowsPerCheck, room));
  const remaining = picked.length - add.length;
  const rangeEnd =
    scope.scope === MangaRequestScope.RANGE ? scope.rangeEnd : null;
  return {
    add,
    remaining,
    limitReached: remaining > 0 && rows.length + add.length >= manifestRows,
    rangeComplete:
      rangeEnd !== null &&
      remaining === 0 &&
      chapters.some(
        ({ chapterNumber }) =>
          isKnownMangaChapterNumber(chapterNumber) && chapterNumber >= rangeEnd
      ),
  };
};

type Pace = 'ongoing' | 'hiatus' | 'finished';

/** AniList decides; the source's status only when AniList has none. */
const paceOf = (
  anilist: AnilistMangaStatus | undefined,
  source: SuwayomiMangaStatus | undefined
): Pace => {
  if (anilist !== undefined) {
    if (anilist === 'HIATUS') return 'hiatus';
    return anilist === 'FINISHED' || anilist === 'CANCELLED'
      ? 'finished'
      : 'ongoing';
  }
  if (source === 'ON_HIATUS') return 'hiatus';
  return source === 'COMPLETED' ||
    source === 'PUBLISHING_FINISHED' ||
    source === 'CANCELLED'
    ? 'finished'
    : 'ongoing';
};

/**
 * The next check: monthly once a finished manga has every row delivered,
 * weekly on hiatus, else every 8 hours, each plus up to 4 hours of jitter.
 */
const nextCheckAt = (
  run: Run,
  nowMs: number,
  pace: Pace,
  delivered: boolean
): Date => {
  const wait =
    pace === 'finished' && delivered
      ? MANGA_FOLLOW_WAIT_MS.finished
      : pace === 'hiatus'
        ? MANGA_FOLLOW_WAIT_MS.hiatus
        : MANGA_FOLLOW_WAIT_MS.ongoing;
  const random = run.random();
  const spread = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  return new Date(
    nowMs + wait + Math.floor(spread * MANGA_FOLLOW_WAIT_MS.jitter)
  );
};

/**
 * Whether the manifest may be checked now, and if not, whether following
 * stops, pauses or simply waits. Read again inside every write.
 */
const judge = async (
  manager: EntityManager,
  manifestId: number
): Promise<Verdict> => {
  const manifest = await manager.findOne(MangaRequestManifest, {
    where: { id: manifestId },
  });
  if (!manifest) return { kind: 'skip' };
  const request = await manager
    .createQueryBuilder(MediaRequest, 'request')
    .leftJoinAndSelect('request.requestedBy', 'owner')
    .leftJoinAndSelect('request.media', 'media')
    .where('request.id = :id', { id: manifest.requestId })
    .getOne();
  if (!request?.media || request.type !== MediaType.MANGA) {
    return { kind: 'skip' };
  }
  const settle = (kind: Settlement['kind'], reason: MangaFollowStopReason) =>
    ({ kind, reason, manifest }) as const;
  if (request.status === MediaRequestStatus.DECLINED) {
    return settle('stop', MangaFollowStopReason.REQUEST_DECLINED);
  }
  if (request.status === MediaRequestStatus.FAILED) {
    return settle('stop', MangaFollowStopReason.REQUEST_FAILED);
  }
  if (
    request.status !== MediaRequestStatus.APPROVED &&
    request.status !== MediaRequestStatus.COMPLETED
  ) {
    return { kind: 'skip' };
  }
  if (
    !request.requestedBy ||
    !hasMediaRequestPermission(request.requestedBy, MediaType.MANGA)
  ) {
    return settle('stop', MangaFollowStopReason.OWNER_NOT_PERMITTED);
  }
  if (manifest.checkpoint !== MangaRequestCheckpoint.CHAPTERS_ENQUEUED) {
    return { kind: 'skip' };
  }
  if (manifest.bindingState !== MangaRequestBindingState.BOUND) {
    return settle('pause', MangaFollowStopReason.BINDING_INACTIVE);
  }
  if (!snapshotSuwayomiInstance(manifest.instanceId)) {
    return settle('pause', MangaFollowStopReason.INSTANCE_MISSING);
  }
  const bindings = await manager.find(MangaSourceBinding, {
    where: {
      instanceId: manifest.instanceId,
      anilistId: manifest.anilistId,
      state: MangaBindingState.ACTIVE,
    },
    order: { id: 'ASC' },
  });
  if (bindings.length === 0) {
    return settle('pause', MangaFollowStopReason.BINDING_INACTIVE);
  }
  const binding = bindings.find(
    ({ sourceId, urlHash }) =>
      sourceId === manifest.bindingSourceId &&
      urlHash === manifest.bindingUrlHash
  );
  return binding
    ? { kind: 'check', manifest, request, binding }
    : settle('pause', MangaFollowStopReason.BINDING_CHANGED);
};

/**
 * Applies a stop or a pause, but only while following is still on: a choice
 * the owner made since then wins.
 */
const applySettlement = async (
  manager: EntityManager,
  manifestId: number,
  { kind, reason }: Settlement
): Promise<boolean> => {
  const result = await manager
    .createQueryBuilder()
    .update(MangaRequestManifest)
    .set(
      kind === 'stop'
        ? { followEnabled: false, followStopReason: reason, followNextAt: null }
        : {
            followStopReason: reason,
            followNextAt: new Date(Date.now() + MANGA_FOLLOW_WAIT_MS.paused),
          }
    )
    .where({ id: manifestId, followEnabled: true })
    .execute();
  return result.affected === 1;
};

const logSettlement = (
  run: Run,
  manifest: Pick<MangaRequestManifest, 'id' | 'requestId'>,
  { kind, reason }: Settlement
): void => {
  run.counts[kind === 'stop' ? 'stopped' : 'paused'] += 1;
  logger.info(
    kind === 'stop' ? 'Manga follow stopped' : 'Manga follow paused',
    {
      label: LABEL,
      requestId: manifest.requestId,
      manifestId: manifest.id,
      code: reason,
    }
  );
};

/**
 * Stops or pauses following as the manifest's current state demands, or
 * with `outcome` when the state allows a check, as a compare-and-set under
 * the request's admission.
 */
const settleFollow = async (
  run: Run,
  manifest: Pick<MangaRequestManifest, 'id' | 'requestId'>,
  outcome?: Settlement
): Promise<void> => {
  const applied = await withRequestAdmission(manifest.requestId, () =>
    dataSource.transaction(async (manager) => {
      const verdict = await judge(manager, manifest.id);
      if (verdict.kind === 'skip' || !verdict.manifest.followEnabled) {
        return undefined;
      }
      const settlement = verdict.kind === 'check' ? outcome : verdict;
      if (!settlement) return undefined;
      return (await applySettlement(manager, manifest.id, settlement))
        ? settlement
        : undefined;
    })
  );
  if (applied) logSettlement(run, manifest, applied);
};

/** Checks the manifest again after `waitMs`, unless following turned off. */
const deferCheck = (
  manifest: Pick<MangaRequestManifest, 'id' | 'requestId'>,
  waitMs: number
): Promise<unknown> =>
  withRequestAdmission(manifest.requestId, () =>
    dataSource
      .createQueryBuilder()
      .update(MangaRequestManifest)
      .set({ followNextAt: new Date(Date.now() + waitMs) })
      .where({ id: manifest.id, followEnabled: true })
      .execute()
  );

/**
 * The server must carry this instance's marker before the run refreshes or
 * queues anything there; checked once per instance and run. Dispatch alone
 * writes markers.
 */
const ensureMarker = async (inst: InstanceRun): Promise<void> => {
  if (inst.markerChecked) return;
  const own = await getRepository(MangaInstanceMarker).findOne({
    where: { instanceId: inst.instanceId },
  });
  if (
    !own ||
    (await inst.client.getInstanceMarker({ signal: inst.run.signal })) !==
      own.marker
  ) {
    throw new InstanceMismatchError();
  }
  inst.markerChecked = true;
};

/**
 * A fresh chapter list of the bound manga, refreshed from the source without
 * its metadata. The cached manga ID is a hint: when it names another manga,
 * or its fetch fails the way a manga Suwayomi no longer has fails, the manga
 * is resolved once by its source and URL. A failure of a manga that still
 * resolves to the cached ID is the source's, and is thrown as it came.
 */
const fetchChapterList = async (
  inst: InstanceRun,
  manifest: MangaRequestManifest,
  binding: MangaSourceBinding,
  key: MangaKey
): Promise<
  | { kind: 'missing' }
  | { kind: 'stale'; issue?: string }
  | {
      kind: 'fresh';
      result: SuwayomiFetchResult & { chapters: SuwayomiChapter[] };
      mangaId: string;
      resolvedId?: number;
    }
> => {
  const options = { fetchManga: false, signal: inst.run.signal };
  const cached = manifest.suwayomiMangaId ?? binding.suwayomiMangaId;
  let mangaId = cached === null ? '' : String(cached);
  let resolvedId: number | undefined;
  let result: SuwayomiFetchResult | undefined;
  let failure: SuwayomiError | undefined;
  if (mangaId) {
    try {
      result = await inst.client.fetchMangaAndChapters(mangaId, options);
    } catch (error) {
      if (!(error instanceof SuwayomiError) || !RESOLVE_CODES.has(error.code)) {
        throw error;
      }
      failure = error;
    }
  }
  if (!result || (result.manga && !isSameManga(result.manga, key))) {
    const found = await inst.client.findMangaByNaturalKey(
      binding.sourceId,
      binding.url,
      { signal: inst.run.signal }
    );
    if (!found || !isSameManga(found, key)) return { kind: 'missing' };
    if (failure && found.id === mangaId) throw failure;
    resolvedId = toStoredMangaId(found.id);
    mangaId = found.id;
    result = await inst.client.fetchMangaAndChapters(mangaId, options);
    if (result.manga && !isSameManga(result.manga, key)) {
      return { kind: 'missing' };
    }
  }
  if (!result.fresh || !result.chapters) {
    return { kind: 'stale', issue: result.issue };
  }
  return {
    kind: 'fresh',
    result: { ...result, chapters: result.chapters },
    mangaId,
    resolvedId,
  };
};

/** AniList's status, read outside every lock; a failure counts as none. */
const anilistStatusOf = async (
  run: Run,
  anilistId: number
): Promise<AnilistMangaStatus | undefined> => {
  try {
    return await run.anilistStatus(anilistId);
  } catch {
    return undefined;
  }
};

/**
 * The status event of a re-opened request, written beside the re-open. It
 * starts a new attempt, so the computed events that follow never repeat a
 * fingerprint of the first delivery, and its own fingerprint is inserted
 * without a conflict that could fail the transaction. A manga request's stage
 * comes from its manifest alone, so nothing of the latest event carries over
 * but its attempt and service.
 */
const insertReopenEvent = async (
  manager: EntityManager,
  request: MediaRequest,
  latest: MediaRequestStatusEvent | null
): Promise<void> => {
  const attempt = (latest?.attempt ?? 0) + 1;
  await manager
    .createQueryBuilder()
    .insert()
    .into(MediaRequestStatusEvent)
    .values({
      requestId: request.id,
      requestedById: request.requestedBy.id,
      mediaId: request.media.id,
      mediaType: request.type,
      stage: RequestStatusStage.APPROVED,
      attempt,
      format: null,
      service: latest?.service ?? null,
      message: REOPEN_MESSAGE,
      percent: null,
      size: null,
      sizeLeft: null,
      estimatedCompletionTime: null,
      downloadCount: 0,
      downloadId: null,
      fingerprint: `manga-follow:${attempt}:${Date.now()}`,
    })
    .orIgnore()
    .execute();
};

/**
 * Adds the check's chapters to the frozen manifest and re-opens a completed
 * request, in one transaction under the request's admission and the manga's
 * dispatch lock: the progress poll never reads the manifest half-written.
 * Every condition is read again first. The rows and the re-open commit
 * together, before anything is queued.
 */
const writeCheck = async (
  inst: InstanceRun,
  manifest: MangaRequestManifest,
  key: MangaKey,
  list: {
    chapters: SuwayomiChapter[];
    source?: SuwayomiMangaStatus;
    anilist?: AnilistMangaStatus;
    resolvedId?: number;
  }
): Promise<Written | Settlement | undefined> => {
  const { run } = inst;
  const candidates = list.chapters.map(toChapterCandidate);
  try {
    return await withRequestAdmission(manifest.requestId, () =>
      withFollowLock(inst.instanceId, key, () =>
        dataSource.transaction(async (manager) => {
          const verdict = await judge(manager, manifest.id);
          if (verdict.kind === 'skip' || !verdict.manifest.followEnabled) {
            return undefined;
          }
          if (verdict.kind !== 'check') {
            return (await applySettlement(manager, manifest.id, verdict))
              ? { kind: verdict.kind, reason: verdict.reason }
              : undefined;
          }
          const current = verdict.manifest;
          if (
            current.instanceId !== inst.instanceId ||
            current.bindingSourceId !== key.sourceId ||
            current.bindingUrlHash !== key.urlHash
          ) {
            return undefined;
          }
          const rows = await manager.find(MangaRequestChapter, {
            select: {
              id: true,
              chapterNumber: true,
              urlHash: true,
              deliverableAt: true,
              lastQueueState: true,
              missingSince: true,
              fileState: true,
              followAddedAt: true,
            },
            where: { manifestId: current.id },
          });
          const selection = selectMangaFollowChapters({
            scope: current,
            rows,
            chapters: candidates,
            scanlatorPreference: inst.snapshot.scanlatorPreference ?? [],
            rowsPerCheck: run.limits.rowsPerCheck,
            manifestRows: run.limits.manifestRows,
          });
          const completed =
            verdict.request.status === MediaRequestStatus.COMPLETED;
          // Completion requires no attention, so this guards a state that
          // should not exist: never re-open over an unresolved problem.
          const blocked =
            completed &&
            selection.add.length > 0 &&
            current.attentionCode !== null;
          const now = new Date();
          const added = blocked
            ? []
            : buildMangaRequestChapterRows(current.id, selection.add).map(
                (row) => ({ ...row, followAddedAt: now })
              );
          const reopened = completed && added.length > 0;
          // The counts describe the rows from the commit on, so a re-opened
          // request shows its new chapters downloading before the next poll
          // counts them again. The added rows are new: nothing verified them.
          const counts =
            added.length > 0
              ? countRows([
                  ...rows,
                  ...added.map((row) => ({
                    ...row,
                    deliverableAt: null,
                    lastQueueState: null,
                    missingSince: null,
                    fileState: null,
                    headCheckedAt: null,
                  })),
                ])
              : undefined;
          const latest = reopened
            ? await manager.findOne(MediaRequestStatusEvent, {
                where: { requestId: verdict.request.id },
                order: { id: 'DESC' },
              })
            : null;
          const approved =
            reopened || verdict.request.status === MediaRequestStatus.APPROVED;
          const enqueue =
            approved &&
            (added.length > 0 ||
              rows.some(
                (row) =>
                  row.followAddedAt !== null && row.deliverableAt === null
              ));
          const delivered =
            added.length === 0 &&
            rows.every(
              (row) => row.deliverableAt !== null && row.missingSince === null
            );
          const stop = blocked
            ? undefined
            : selection.limitReached
              ? MangaFollowStopReason.MANIFEST_LIMIT
              : selection.rangeComplete
                ? MangaFollowStopReason.RANGE_COMPLETE
                : undefined;
          // Chapters the per-check bound held back come within the hour.
          const cadence =
            stop === undefined && !blocked && selection.remaining > 0
              ? new Date(now.getTime() + MANGA_FOLLOW_WAIT_MS.retry)
              : nextCheckAt(
                  run,
                  now.getTime(),
                  paceOf(list.anilist, list.source),
                  delivered
                );
          assertSameInstance(inst.snapshot);

          for (const slice of chunk(added, INSERT_SLICE)) {
            await manager
              .createQueryBuilder()
              .insert()
              .into(MangaRequestChapter)
              .values(slice)
              .orIgnore()
              .execute();
          }
          if (reopened) {
            const result = await manager
              .createQueryBuilder()
              .update(MediaRequest)
              .set({ status: MediaRequestStatus.APPROVED })
              .where({
                id: verdict.request.id,
                status: MediaRequestStatus.COMPLETED,
              })
              .callListeners(false)
              .execute();
            if (result.affected !== 1) throw new FollowMovedError();
            await insertReopenEvent(manager, verdict.request, latest);
          }
          // An enqueue that cannot finish leaves the manifest due within the
          // hour, and the next check retries it; a stop waits for it.
          const stopNow = stop !== undefined && !enqueue;
          const nextAt = enqueue
            ? new Date(now.getTime() + MANGA_FOLLOW_WAIT_MS.retry)
            : cadence;
          const result = await manager
            .createQueryBuilder()
            .update(MangaRequestManifest)
            .set({
              followLastAt: now,
              followStopReason: stopNow ? stop : null,
              followNextAt: stopNow ? null : nextAt,
              ...(stopNow && { followEnabled: false }),
              ...(counts && {
                chaptersTotal: counts.total,
                chaptersVerified: counts.verified,
                chaptersQueued: counts.queued,
                chaptersDownloading: counts.downloading,
                chaptersErrored: counts.errored,
                chaptersMissing: counts.missing,
                progressSignature: null,
                progressAt: null,
              }),
              ...(list.resolvedId !== undefined && {
                suwayomiMangaId: list.resolvedId,
              }),
            })
            .where({ id: current.id, followEnabled: true })
            .execute();
          if (result.affected !== 1) throw new FollowMovedError();
          if (blocked) {
            logger.warn('Manga follow left a completed request closed', {
              label: LABEL,
              requestId: verdict.request.id,
              manifestId: current.id,
              code: 'MANGA_FOLLOW_REOPEN_BLOCKED',
            });
          }
          return {
            added: added.length,
            reopened,
            enqueue,
            stopAfter: enqueue ? stop : undefined,
            stopped: stopNow ? stop : undefined,
            nextAt: cadence,
          };
        })
      )
    );
  } catch (error) {
    if (error instanceof FollowMovedError) return undefined;
    throw error;
  }
};

/**
 * Queues the followed chapters not delivered yet that Suwayomi lists as
 * neither downloaded nor queued, the way dispatch queues its chapters: under
 * the manga's dispatch lock with no admission, each batch's ownership rows
 * written first in a short transaction whose last read is the instance
 * check. Stops once the request is no longer approved or the manifest moved.
 */
const enqueueFollowed = async (
  inst: InstanceRun,
  manifest: MangaRequestManifest,
  key: MangaKey,
  mangaId: string
): Promise<void> =>
  withFollowLock(inst.instanceId, key, async () => {
    const pending = await getRepository(MangaRequestChapter).find({
      select: { id: true, url: true, urlHash: true, missingSince: true },
      where: {
        manifestId: manifest.id,
        followAddedAt: Not(IsNull()),
        deliverableAt: IsNull(),
      },
      order: { id: 'ASC' },
    });
    if (pending.length === 0) return;
    const call = { signal: inst.run.signal };
    const { client } = inst;
    const waiting = await client.getChaptersToDownload(mangaId, call);
    const downloaded = await client.getDownloadedChapters(mangaId, call);
    const queue = await client.getQueue(call);

    const downloadedHashes = new Set(
      downloaded.map(({ url }) => hashMangaSourceUrl(url))
    );
    const chapterIds = new Map<string, string>();
    for (const chapter of waiting) {
      const urlHash = hashMangaSourceUrl(chapter.url);
      if (!chapterIds.has(urlHash)) chapterIds.set(urlHash, chapter.id);
    }
    const queued = new Set(queue.items.map(({ chapterId }) => chapterId));
    const batches: { row: MangaRequestChapter; chapterId: string }[] = [];
    let unmapped = 0;
    for (const row of pending) {
      if (downloadedHashes.has(row.urlHash)) continue;
      const chapterId = chapterIds.get(row.urlHash);
      if (chapterId === undefined) {
        // The progress poll already reports chapters it marked missing.
        if (row.missingSince === null) unmapped += 1;
      } else if (!queued.has(chapterId)) {
        batches.push({ row, chapterId });
      }
    }
    if (unmapped > 0) {
      logger.warn('Followed manga chapters Suwayomi no longer lists', {
        label: LABEL,
        requestId: manifest.requestId,
        manifestId: manifest.id,
        code: 'MANGA_FOLLOW_CHAPTERS_UNMAPPED',
        count: unmapped,
      });
    }

    for (const batch of chunk(batches, QUEUE_BATCH_SIZE)) {
      inst.run.signal?.throwIfAborted();
      const owned = await dataSource.transaction(async (manager) => {
        const request = await manager
          .createQueryBuilder(MediaRequest, 'request')
          .select(['request.id', 'request.status'])
          .where('request.id = :id', { id: manifest.requestId })
          .getOne();
        const current = await manager.findOne(MangaRequestManifest, {
          where: { id: manifest.id },
        });
        if (
          request?.status !== MediaRequestStatus.APPROVED ||
          !current ||
          current.instanceId !== inst.instanceId ||
          current.bindingState !== MangaRequestBindingState.BOUND ||
          current.checkpoint !== MangaRequestCheckpoint.CHAPTERS_ENQUEUED ||
          current.bindingSourceId !== key.sourceId ||
          current.bindingUrlHash !== key.urlHash
        ) {
          return false;
        }
        assertSameInstance(inst.snapshot);
        await manager
          .createQueryBuilder()
          .insert()
          .into(MangaChapterOwnership)
          .values(
            batch.map(({ row }) => ({
              instanceId: inst.instanceId,
              sourceId: key.sourceId,
              mangaUrlHash: key.urlHash,
              chapterUrlHash: row.urlHash,
              chapterUrl: row.url,
            }))
          )
          .orIgnore()
          .execute();
        return true;
      });
      if (!owned) return;
      await client.enqueueChapters(
        batch.map(({ chapterId }) => chapterId),
        call
      );
      inst.run.counts.enqueued += batch.length;
    }
  });

/**
 * After the enqueue: the check's real next time, or the stop it held back,
 * unless the owner turned following off or asked for a check since.
 */
const finishCheck = async (
  run: Run,
  manifest: MangaRequestManifest,
  written: Written
): Promise<void> => {
  const stopped = await withRequestAdmission(manifest.requestId, () =>
    dataSource.transaction(async (manager) => {
      const current = await manager.findOne(MangaRequestManifest, {
        where: { id: manifest.id },
      });
      if (!current?.followEnabled || current.followNextAt === null) {
        return undefined;
      }
      if (written.stopAfter) {
        return (await applySettlement(manager, manifest.id, {
          kind: 'stop',
          reason: written.stopAfter,
        }))
          ? written.stopAfter
          : undefined;
      }
      await manager
        .createQueryBuilder()
        .update(MangaRequestManifest)
        .set({ followNextAt: written.nextAt })
        .where({ id: manifest.id, followEnabled: true })
        .execute();
      return undefined;
    })
  );
  if (stopped) logSettlement(run, manifest, { kind: 'stop', reason: stopped });
};

/** One due manifest: judge, fetch, write, then queue what it added. */
const checkManifest = async (
  inst: InstanceRun,
  selected: MangaRequestManifest
): Promise<void> => {
  const { run } = inst;
  const verdict = await judge(dataSource.manager, selected.id);
  if (verdict.kind === 'skip' || !verdict.manifest.followEnabled) return;
  if (verdict.kind !== 'check') {
    await settleFollow(run, selected);
    return;
  }
  const { manifest, binding } = verdict;
  const key: MangaKey = {
    sourceId: binding.sourceId,
    urlHash: binding.urlHash,
  };
  await ensureMarker(inst);
  const list = await fetchChapterList(inst, manifest, binding, key);
  if (list.kind === 'missing') {
    await settleFollow(run, manifest, {
      kind: 'pause',
      reason: MangaFollowStopReason.MANGA_NOT_FOUND,
    });
    return;
  }
  if (list.kind === 'stale') {
    logger.warn('Manga follow found no fresh chapter list', {
      label: LABEL,
      requestId: manifest.requestId,
      manifestId: manifest.id,
      code: 'MANGA_FOLLOW_LIST_STALE',
      issue: list.issue ?? null,
    });
    await deferCheck(manifest, MANGA_FOLLOW_WAIT_MS.retry);
    return;
  }
  const anilist = await anilistStatusOf(run, manifest.anilistId);
  const written = await writeCheck(inst, manifest, key, {
    chapters: list.result.chapters,
    source: list.result.manga?.status,
    anilist,
    resolvedId: list.resolvedId,
  });
  if (!written) return;
  if (!('added' in written)) {
    logSettlement(run, manifest, written);
    return;
  }
  run.counts.checked += 1;
  run.counts.added += written.added;
  if (written.reopened) run.counts.reopened += 1;
  if (written.added > 0) {
    logger.info('Manga follow added chapters', {
      label: LABEL,
      requestId: manifest.requestId,
      manifestId: manifest.id,
      count: written.added,
      reopened: written.reopened,
    });
  }
  if (written.stopped) {
    logSettlement(run, manifest, { kind: 'stop', reason: written.stopped });
  }
  if (!written.enqueue) return;
  await enqueueFollowed(inst, manifest, key, list.mangaId);
  await finishCheck(run, manifest, written);
};

/**
 * One instance's due manifests, one at a time. The first failure every later
 * call would hit too stops the instance and leaves the rest due.
 */
const followInstance = async (
  run: Run,
  instanceId: number,
  manifests: readonly MangaRequestManifest[]
): Promise<void> => {
  const snapshot = snapshotSuwayomiInstance(instanceId);
  if (!snapshot) {
    for (const manifest of manifests) {
      run.signal?.throwIfAborted();
      await settleFollow(run, manifest);
    }
    return;
  }
  const client = run.clientFor(instanceId);
  if (!client) {
    logger.warn('Manga follow stopped on an instance', {
      label: LABEL,
      code: 'NO_CLIENT',
      instanceId,
    });
    run.counts.instancesFailed += 1;
    return;
  }
  const inst: InstanceRun = {
    run,
    instanceId,
    snapshot,
    client,
    markerChecked: false,
  };
  for (const manifest of manifests) {
    run.signal?.throwIfAborted();
    try {
      await checkManifest(inst, manifest);
    } catch (error) {
      if (run.signal?.aborted) throw error;
      if (isStop(run, error)) {
        logger.warn('Manga follow stopped on an instance', {
          label: LABEL,
          instanceId,
          ...errorDetails(error),
        });
        run.counts.instancesFailed += 1;
        return;
      }
      if (!(error instanceof SuwayomiError)) throw error;
      logger.warn('Manga follow skipped a manga', {
        label: LABEL,
        instanceId,
        requestId: manifest.requestId,
        manifestId: manifest.id,
        ...errorDetails(error),
      });
      await deferCheck(manifest, MANGA_FOLLOW_WAIT_MS.retry);
    }
  }
};

/** Manifests whose following is on but whose request was declined or failed. */
const sweepStops = async (run: Run): Promise<void> => {
  const manifests = await getRepository(MangaRequestManifest)
    .createQueryBuilder('manifest')
    .innerJoin(MediaRequest, 'request', 'request.id = manifest.requestId')
    .where('manifest.followEnabled = :enabled', { enabled: true })
    .andWhere('request.status IN (:...statuses)', {
      statuses: [MediaRequestStatus.DECLINED, MediaRequestStatus.FAILED],
    })
    .orderBy('manifest.id', 'ASC')
    .limit(run.limits.stops)
    .getMany();
  for (const manifest of manifests) {
    run.signal?.throwIfAborted();
    await settleFollow(run, manifest);
  }
};

/** Following on, the time come, dispatch done, the request open or done. */
const dueManifests = (now: Date) =>
  getRepository(MangaRequestManifest)
    .createQueryBuilder('manifest')
    .innerJoin(MediaRequest, 'request', 'request.id = manifest.requestId')
    .where('manifest.followEnabled = :enabled', { enabled: true })
    .andWhere(
      '(manifest.followNextAt IS NULL OR manifest.followNextAt <= :now)',
      {
        now,
      }
    )
    .andWhere('manifest.checkpoint = :checkpoint', {
      checkpoint: MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
    })
    .andWhere('request.type = :type', { type: MediaType.MANGA })
    .andWhere('request.status IN (:...statuses)', {
      statuses: [MediaRequestStatus.APPROVED, MediaRequestStatus.COMPLETED],
    });

const dueOrder = (manifest: MangaRequestManifest): number =>
  manifest.followNextAt?.getTime() ?? -Infinity;

/**
 * The run's checks by instance, oldest due first: at most `perSource` per
 * source of an instance, and `perInstance` per instance.
 */
const selectDue = async (
  run: Run
): Promise<Map<number, MangaRequestManifest[]>> => {
  const now = new Date();
  const pairs = await dueManifests(now)
    .select('manifest.instanceId', 'instanceId')
    .addSelect('manifest.bindingSourceId', 'sourceId')
    .distinct(true)
    .getRawMany<{ instanceId: number | string; sourceId: string | null }>();
  const byInstance = new Map<number, MangaRequestManifest[]>();
  for (const pair of pairs) {
    const instanceId = Number(pair.instanceId);
    const query = dueManifests(now).andWhere(
      'manifest.instanceId = :instanceId',
      { instanceId }
    );
    if (pair.sourceId === null) {
      query.andWhere('manifest.bindingSourceId IS NULL');
    } else {
      query.andWhere('manifest.bindingSourceId = :sourceId', {
        sourceId: pair.sourceId,
      });
    }
    const manifests = await query
      .orderBy('manifest.followNextAt', 'ASC', 'NULLS FIRST')
      .addOrderBy('manifest.id', 'ASC')
      .limit(run.limits.perSource)
      .getMany();
    byInstance.set(instanceId, [
      ...(byInstance.get(instanceId) ?? []),
      ...manifests,
    ]);
  }
  const selected = new Map<number, MangaRequestManifest[]>();
  for (const instanceId of [...byInstance.keys()].sort((a, b) => a - b)) {
    selected.set(
      instanceId,
      (byInstance.get(instanceId) ?? [])
        .sort(
          (left, right) =>
            dueOrder(left) - dueOrder(right) || left.id - right.id
        )
        .slice(0, run.limits.perInstance)
    );
  }
  return selected;
};

/**
 * One follow run: stops for declined and failed requests, then the due
 * checks, instance by instance. A failure on one instance leaves the others
 * alone.
 */
export const runMangaFollow = async (
  options: MangaFollowOptions = {}
): Promise<MangaFollowCounts> => {
  let anilist: AnilistAPI | undefined;
  const run: Run = {
    signal: options.signal,
    clientFor: options.clientFor ?? getSuwayomiClient,
    anilistStatus:
      options.anilistStatus ??
      (async (anilistId) =>
        (await (anilist ??= new AnilistAPI()).getMangaDetails(anilistId))
          ?.status),
    random: options.random ?? Math.random,
    limits: {
      perInstance:
        options.limits?.perInstance ?? MANGA_FOLLOW_CHECKS_PER_INSTANCE,
      perSource: options.limits?.perSource ?? MANGA_FOLLOW_CHECKS_PER_SOURCE,
      stops: options.limits?.stops ?? MANGA_FOLLOW_STOPS_PER_RUN,
      rowsPerCheck: options.limits?.rowsPerCheck ?? MANGA_FOLLOW_ROWS_PER_CHECK,
      manifestRows: options.limits?.manifestRows ?? MANGA_FOLLOW_MANIFEST_LIMIT,
    },
    counts: {
      checked: 0,
      added: 0,
      reopened: 0,
      stopped: 0,
      paused: 0,
      enqueued: 0,
      instancesFailed: 0,
    },
  };
  await sweepStops(run);
  for (const [instanceId, manifests] of await selectDue(run)) {
    run.signal?.throwIfAborted();
    try {
      await followInstance(run, instanceId, manifests);
    } catch (error) {
      if (run.signal?.aborted) throw error;
      logger.error('Manga follow failed on an instance', {
        label: LABEL,
        instanceId,
        ...errorDetails(error),
      });
      run.counts.instancesFailed += 1;
    }
  }
  return run.counts;
};

/** The scheduled job's runner: one run at a time, and cancellable. */
class MangaFollowPoller {
  private controller?: AbortController;

  public status(): { running: boolean } {
    return { running: this.controller !== undefined };
  }

  public cancel(): void {
    this.controller?.abort();
  }

  /** Never throws: the job runner would log a thrown error's message. */
  public async run(): Promise<void> {
    if (this.controller || !isMediaCategoryEnabled('manga')) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const counts = await runMangaFollow({ signal: controller.signal });
      logger.debug('Manga follow run finished', { label: LABEL, ...counts });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        logger.info('Manga follow run cancelled', { label: LABEL });
      } else {
        logger.error('Manga follow run failed', {
          label: LABEL,
          ...errorDetails(error),
        });
      }
    } finally {
      this.controller = undefined;
    }
  }
}

export const mangaFollowPoller = new MangaFollowPoller();

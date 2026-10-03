import type SuwayomiAPI from '@server/api/suwayomi';
import {
  SuwayomiError,
  type SuwayomiErrorCode,
} from '@server/api/suwayomi/errors';
import type {
  SuwayomiAvailability,
  SuwayomiChapter,
  SuwayomiMangaDetails,
  SuwayomiQueue,
  SuwayomiQueueItem,
} from '@server/api/suwayomi/types';
import {
  MANGA_CHAPTER_MISSING_GRACE_MS,
  MANGA_PROGRESS_HEADS_PER_INSTANCE,
  MANGA_PROGRESS_MANIFESTS_PER_RUN,
  MANGA_PROGRESS_RECHECK_MS,
  MangaAttentionCode,
  MangaChapterFileState,
  MangaChapterQueueState,
  MangaRequestBindingState,
  MangaRequestCheckpoint,
} from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaLibraryOwnership from '@server/entity/MangaLibraryOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import MediaIdentifier from '@server/entity/MediaIdentifier';
import {
  MediaRequest,
  getRequestMutationAdmissionKey,
  runWithRequestAdmission,
} from '@server/entity/MediaRequest';
import downloadTracker, {
  type DownloadingItem,
} from '@server/lib/downloadtracker';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { computeMangaAvailability } from '@server/lib/mangaAvailability';
import { runWithMangaDispatchLock } from '@server/lib/mangaDispatch';
import {
  newMangaMediaTally,
  reconcileMangaMedia,
} from '@server/lib/mangaMedia';
import { enqueueMangaRequestDispatch } from '@server/lib/mangaRequestBindings';
import {
  buildMangaRequestChapterRows,
  isKnownMangaChapterNumber,
} from '@server/lib/mangaRequests';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import { runMediaEntityMutation } from '@server/lib/mediaMutation';
import { hasSameServarrServiceAuthority } from '@server/lib/serviceAdmission';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import {
  SuwayomiInstanceChangedError,
  runWithSuwayomiInstanceAdmission,
  snapshotSuwayomiInstance,
} from '@server/lib/suwayomi/instanceAdmission';
import logger from '@server/logger';
import { chunk } from '@server/utils/chunk';
import { isUniqueConstraintError } from '@server/utils/databaseError';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { In, IsNull, Not, type EntityManager } from 'typeorm';

/*
 * The manga progress poll: what became of the chapters an enqueued request
 * froze. Per instance it reads availability and the queue in one batch, then
 * per source manga, under the dispatch lock, reads the chapter lists when
 * anything changed, maps the frozen rows to current chapters, checks the
 * files Suwayomi lists as downloaded with a HEAD request, and records
 * progress and attention on the manifest. After the instance it refreshes the
 * bindings it read, reconciles their media, and completes the requests whose
 * every chapter is delivered. It never enqueues, deletes or re-dispatches.
 */

const LABEL = 'Manga Progress';
/** Manga IDs per availability call. */
const AVAILABILITY_BATCH = 100;
/** Bindings refreshed per transaction. */
const BINDING_BATCH = 50;
const ID_SLICE = 500;
const MAX_SUWAYOMI_INT = 2_147_483_647;

/** Failures that stop the poll of an instance, not just one manga. */
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

const TRACKER_STATUS: Partial<Record<string, string>> = {
  [MangaChapterQueueState.QUEUED]: 'queued',
  [MangaChapterQueueState.DOWNLOADING]: 'downloading',
  [MangaChapterQueueState.ERROR]: 'failed',
};

export type MangaProgressClient = Pick<
  SuwayomiAPI,
  | 'getAvailability'
  | 'getQueue'
  | 'findMangaByNaturalKey'
  | 'getChaptersToDownload'
  | 'getDownloadedChapters'
  | 'headChapterArchive'
>;

export interface MangaProgressOptions {
  signal?: AbortSignal;
  /** Replaces the shared client factory; tests pass their own client. */
  clientFor?: (instanceId: number) => MangaProgressClient | undefined;
  /** Bounds below the defaults, for tests. */
  limits?: { manifests?: number; heads?: number };
}

export interface MangaProgressCounts {
  /** Manifests the run selected. */
  manifests: number;
  /** Source manga whose chapter lists the run read. */
  chapterReads: number;
  heads: number;
  completed: number;
  instancesFailed: number;
}

interface Run {
  signal?: AbortSignal;
  clientFor: (instanceId: number) => MangaProgressClient | undefined;
  heads: number;
  counts: MangaProgressCounts;
}

/** One source manga of an instance: the dispatch lock's key. */
interface MangaKey {
  sourceId: string;
  urlHash: string;
}

/** A binding whose availability inputs the read refreshed. */
interface BindingRefresh extends MangaKey {
  /** The key's bindings as the read loaded them. */
  loaded: string;
  bindingId: number;
  anilistId: number;
  values: Partial<MangaSourceBinding>;
}

interface InstanceRun {
  run: Run;
  instanceId: number;
  snapshot: SuwayomiSettings;
  client: MangaProgressClient;
  availability: Map<string, SuwayomiAvailability>;
  queueById: Map<string, SuwayomiQueueItem>;
  queueByManga: Map<string, SuwayomiQueueItem[]>;
  headsLeft: number;
  /** Manifests the run is done with: written, moved away or deferred. */
  settled: Set<number>;
  /** Titles whose tracker items the run rebuilt, and those items. */
  trackedTitles: Set<number>;
  trackerItems: DownloadingItem[];
  refreshes: BindingRefresh[];
  /** Requests whose manifests the run found fully delivered. */
  completions: number[];
}

/** The fields of a chapter row the poll keeps. */
type RowState = Pick<
  MangaRequestChapter,
  | 'url'
  | 'urlHash'
  | 'deliverableAt'
  | 'lastQueueState'
  | 'missingSince'
  | 'fileState'
  | 'headCheckedAt'
>;

interface PlannedRow {
  row: MangaRequestChapter;
  next: RowState;
  /** The current chapter the row maps to. */
  chapter?: SuwayomiChapter;
  remapped: boolean;
  /** Unverified and neither downloaded, queued nor in error on two polls. */
  flagged: boolean;
}

interface Progress {
  total: number;
  verified: number;
  queued: number;
  downloading: number;
  errored: number;
  missing: number;
}

type MangaReadState = Pick<
  SuwayomiAvailability,
  | 'inLibrary'
  | 'downloadCount'
  | 'chapterCount'
  | 'hasDuplicateChapters'
  | 'chaptersLastFetchedAt'
>;

/** Rolls a manifest's write back when the manifest moved under it. */
class ManifestMovedError extends Error {}

const progressLockScope = new AsyncLocalStorage<true>();

/** Whether the caller runs while the poll holds a dispatch lock. */
export const isInsideMangaProgressLock = (): boolean =>
  progressLockScope.getStore() === true;

/**
 * Throws unless the instance still has the address and login the snapshot
 * was taken with. Each write transaction calls it as its last read.
 */
export const assertSameInstance = (snapshot: SuwayomiSettings): void => {
  const current = getExternalRuntimeConfig().suwayomi.find(
    (instance) => instance.id === snapshot.id
  );
  if (!current || !hasSameServarrServiceAuthority(current, snapshot)) {
    throw new SuwayomiInstanceChangedError();
  }
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const errorDetails = (error: unknown): Record<string, unknown> =>
  error instanceof SuwayomiError
    ? { suwayomiCode: error.code, operation: error.operation }
    : { errorName: error instanceof Error ? error.name : typeof error };

/** A failure after which nothing else on the instance would work either. */
const isStop = (run: Run, error: unknown): boolean =>
  error instanceof SuwayomiInstanceChangedError ||
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

/** Whether Suwayomi's manga is the source manga the key names. */
export const isSameManga = (
  details: Pick<SuwayomiMangaDetails, 'sourceId' | 'url'>,
  key: MangaKey
): boolean =>
  details.sourceId === key.sourceId &&
  hashMangaSourceUrl(details.url) === key.urlHash;

const keyOf = ({ sourceId, urlHash }: MangaKey): string =>
  `${sourceId}\n${urlHash}`;

/** Suwayomi reports progress as a fraction; the tracker shows a percent. */
const percentOf = (item: SuwayomiQueueItem | undefined): number | undefined =>
  typeof item?.progress === 'number' && Number.isFinite(item.progress)
    ? Math.min(100, Math.max(0, Math.round(item.progress * 100)))
    : undefined;

/**
 * Everything a chapter read learns from, hashed: while a manga's signature
 * matches the one stored at its last read, its rows are still what that read
 * found, and the poll skips the read.
 */
const signatureOf = (
  manga: MangaReadState,
  items: readonly SuwayomiQueueItem[]
): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        manga.inLibrary,
        manga.downloadCount,
        manga.chapterCount,
        manga.hasDuplicateChapters,
        manga.chaptersLastFetchedAt ?? null,
        [...items]
          .sort(
            (left, right) => Number(left.chapterId) - Number(right.chapterId)
          )
          .map((item) => [
            item.chapterId,
            item.state,
            percentOf(item) ?? null,
            item.tries ?? 0,
          ]),
      ])
    )
    .digest('hex');

const queueStateOf = (
  chapter: SuwayomiChapter,
  item: SuwayomiQueueItem | undefined
): MangaChapterQueueState => {
  if (chapter.isDownloaded) return MangaChapterQueueState.DOWNLOADED;
  switch (item?.state) {
    case undefined:
      return MangaChapterQueueState.NOT_QUEUED;
    case 'ERROR':
      return MangaChapterQueueState.ERROR;
    case 'DOWNLOADING':
    case 'FINISHED':
      return MangaChapterQueueState.DOWNLOADING;
    default:
      return MangaChapterQueueState.QUEUED;
  }
};

const isDue = (checkedAt: Date | null, now: number): boolean =>
  checkedAt === null || now - checkedAt.getTime() >= MANGA_PROGRESS_RECHECK_MS;

/**
 * An unverified chapter Suwayomi lists as downloaded: at once, again on the
 * next poll after an empty file, then after the recheck delay. A verified
 * one Suwayomi stopped listing as downloaded: after the recheck delay.
 */
const isHeadDue = (state: RowState, now: number): boolean =>
  state.deliverableAt === null
    ? state.lastQueueState === MangaChapterQueueState.DOWNLOADED &&
      (state.fileState === MangaChapterFileState.EMPTY ||
        isDue(state.headCheckedAt, now))
    : state.lastQueueState !== MangaChapterQueueState.DOWNLOADED &&
      isDue(state.headCheckedAt, now);

const sameTime = (left: Date | null, right: Date | null): boolean =>
  left === right ||
  (left !== null && right !== null && left.getTime() === right.getTime());

const normalizeScanlator = (value: string | null | undefined): string =>
  (value ?? '').trim().toLowerCase();

/** One source manga's stored bindings, as a value a later read can compare. */
const fingerprint = (bindings: readonly MangaSourceBinding[]): string =>
  JSON.stringify(
    [...bindings].sort((left, right) => left.id - right.id),
    (key, value: unknown) =>
      key === 'createdAt' || key === 'updatedAt' ? undefined : value
  );

const changedValues = <Row extends object>(
  row: Row,
  wanted: Partial<Row>
): Partial<Row> => {
  const changed: Partial<Row> = {};
  for (const key of Object.keys(wanted) as (keyof Row)[]) {
    if (row[key] !== wanted[key]) changed[key] = wanted[key];
  }
  return changed;
};

/**
 * Verified rows count as verified whatever Suwayomi says now. Of the others,
 * a downloaded chapter waiting for its HEAD counts as downloading, and one
 * whose file is missing, unmapped or not queued counts as missing.
 */
export const countRows = (states: readonly RowState[]): Progress => {
  const progress: Progress = {
    total: states.length,
    verified: 0,
    queued: 0,
    downloading: 0,
    errored: 0,
    missing: 0,
  };
  for (const state of states) {
    if (state.deliverableAt !== null) {
      progress.verified += 1;
      continue;
    }
    switch (state.lastQueueState) {
      case MangaChapterQueueState.DOWNLOADING:
        progress.downloading += 1;
        break;
      case MangaChapterQueueState.DOWNLOADED:
        if (state.fileState === MangaChapterFileState.MISSING) {
          progress.missing += 1;
        } else {
          progress.downloading += 1;
        }
        break;
      case MangaChapterQueueState.ERROR:
        progress.errored += 1;
        break;
      case MangaChapterQueueState.NOT_QUEUED:
      case MangaChapterQueueState.UNMAPPED:
        progress.missing += 1;
        break;
      default:
        progress.queued += 1;
    }
  }
  return progress;
};

interface AttentionInput {
  /** The bound manga resolved on Suwayomi at the last read. */
  resolved: boolean;
  inLibrary: boolean;
  /** The key's live binding when it belongs to the manifest's title. */
  pair: MangaSourceBinding | undefined;
  states: readonly RowState[];
  flagged: boolean;
  now: number;
}

/** The one code a manifest shows, by precedence; the counts carry the rest. */
const attentionOf = ({
  resolved,
  inLibrary,
  pair,
  states,
  flagged,
  now,
}: AttentionInput): MangaAttentionCode | null => {
  if (!resolved || !pair) return MangaAttentionCode.BINDING_ORPHANED;
  if (!inLibrary) return MangaAttentionCode.NOT_IN_LIBRARY;
  if (pair.state === MangaBindingState.ORPHANED) {
    return MangaAttentionCode.BINDING_ORPHANED;
  }
  const unverified = states.filter((state) => state.deliverableAt === null);
  const has = (test: (state: RowState) => boolean) => unverified.some(test);
  if (has((state) => state.lastQueueState === MangaChapterQueueState.ERROR)) {
    return MangaAttentionCode.CHAPTER_ERROR;
  }
  if (has((state) => state.fileState === MangaChapterFileState.MISSING)) {
    return MangaAttentionCode.CHAPTER_FILE_MISSING;
  }
  if (has((state) => state.fileState === MangaChapterFileState.NO_LENGTH)) {
    return MangaAttentionCode.CHAPTER_LENGTH_UNKNOWN;
  }
  if (
    has(
      (state) =>
        state.lastQueueState === MangaChapterQueueState.UNMAPPED &&
        state.missingSince !== null &&
        now - state.missingSince.getTime() >= MANGA_CHAPTER_MISSING_GRACE_MS
    )
  ) {
    return MangaAttentionCode.CHAPTER_MISSING;
  }
  return flagged ? MangaAttentionCode.CHAPTER_NOT_QUEUED : null;
};

/** A queued, downloading or failed chapter, labelled by its number only. */
const toTrackerItem = (
  anilistId: number,
  row: Pick<MangaRequestChapter, 'id' | 'chapterNumber'>,
  state: RowState,
  percent: number | undefined
): DownloadingItem | undefined => {
  const status =
    state.deliverableAt === null && state.lastQueueState
      ? TRACKER_STATUS[state.lastQueueState]
      : undefined;
  if (!status) return undefined;
  return {
    mediaType: MediaType.MANGA,
    externalId: anilistId,
    size: 0,
    sizeLeft: 0,
    status,
    timeLeft: 'unknown',
    estimatedCompletionTime: new Date(Number.NaN),
    title: isKnownMangaChapterNumber(row.chapterNumber)
      ? `Chapter ${row.chapterNumber}`
      : 'Chapter',
    downloadId: `manga-${row.id}`,
    ...(percent !== undefined ? { percent } : {}),
  };
};

/** The current chapters of one source manga, from one read of both lists. */
interface ChapterIndex {
  /** By ID; the downloaded list, read second, wins a chapter in both. */
  byId: Map<string, SuwayomiChapter>;
  /** The chapter a URL hash maps to: a downloaded one first, as L11 does. */
  byHash: Map<string, SuwayomiChapter>;
  /** Remap targets by chapter number and normalized scanlator. */
  byNumber: Map<string, SuwayomiChapter[]>;
}

const numberKey = (chapterNumber: number, scanlator: string | null): string =>
  `${chapterNumber}\n${normalizeScanlator(scanlator)}`;

const indexChapters = (
  waiting: readonly SuwayomiChapter[],
  downloaded: readonly SuwayomiChapter[]
): ChapterIndex => {
  const byId = new Map<string, SuwayomiChapter>();
  for (const chapter of [...waiting, ...downloaded]) {
    byId.set(chapter.id, chapter);
  }
  const byHash = new Map<string, SuwayomiChapter>();
  for (const chapter of [...downloaded, ...waiting]) {
    const urlHash = hashMangaSourceUrl(chapter.url);
    if (!byHash.has(urlHash)) byHash.set(urlHash, byId.get(chapter.id)!);
  }
  // Stored the way a manifest stores its rows: valid URLs once each, known
  // numbers only, scanlators trimmed.
  const byNumber = new Map<string, SuwayomiChapter[]>();
  for (const candidate of buildMangaRequestChapterRows(
    0,
    [...byId.values()].map((chapter) => ({
      url: chapter.url,
      chapterNumber: chapter.chapterNumber,
      scanlator: chapter.scanlator ?? null,
    }))
  )) {
    const chapter = byHash.get(candidate.urlHash);
    if (!chapter || !isKnownMangaChapterNumber(candidate.chapterNumber)) {
      continue;
    }
    const key = numberKey(candidate.chapterNumber, candidate.scanlator);
    byNumber.set(key, [...(byNumber.get(key) ?? []), chapter]);
  }
  return { byId, byHash, byNumber };
};

const stateOf = (row: MangaRequestChapter): RowState => ({
  url: row.url,
  urlHash: row.urlHash,
  deliverableAt: row.deliverableAt,
  lastQueueState: row.lastQueueState,
  missingSince: row.missingSince,
  fileState: row.fileState,
  headCheckedAt: row.headCheckedAt,
});

const isSameState = (left: RowState, right: RowState): boolean =>
  left.url === right.url &&
  left.urlHash === right.urlHash &&
  left.lastQueueState === right.lastQueueState &&
  left.fileState === right.fileState &&
  sameTime(left.deliverableAt, right.deliverableAt) &&
  sameTime(left.missingSince, right.missingSince) &&
  sameTime(left.headCheckedAt, right.headCheckedAt);

/**
 * Maps one manifest's rows to current chapters. A row whose URL is gone moves
 * to the one chapter with its number and scanlator, unless that chapter's URL
 * is already one of the manifest's rows or another row wants it too.
 */
const planRows = (
  rows: readonly MangaRequestChapter[],
  index: ChapterIndex,
  queueById: ReadonlyMap<string, SuwayomiQueueItem>,
  now: Date
): PlannedRow[] => {
  const hashes = new Set(rows.map((row) => row.urlHash));
  const targets = new Map<number, SuwayomiChapter>();
  const claims = new Map<string, number>();
  for (const row of rows) {
    if (
      index.byHash.has(row.urlHash) ||
      !isKnownMangaChapterNumber(row.chapterNumber)
    ) {
      continue;
    }
    const matches =
      index.byNumber.get(numberKey(row.chapterNumber, row.scanlator)) ?? [];
    const urlHash =
      matches.length === 1 ? hashMangaSourceUrl(matches[0].url) : undefined;
    if (urlHash === undefined || hashes.has(urlHash)) continue;
    targets.set(row.id, matches[0]);
    claims.set(urlHash, (claims.get(urlHash) ?? 0) + 1);
  }
  return rows.map((row) => {
    let next = stateOf(row);
    let chapter = index.byHash.get(row.urlHash);
    const target = chapter ? undefined : targets.get(row.id);
    const remapped =
      target !== undefined && claims.get(hashMangaSourceUrl(target.url)) === 1;
    if (remapped) {
      chapter = target;
      next = {
        ...next,
        url: target.url,
        urlHash: hashMangaSourceUrl(target.url),
        deliverableAt: null,
        fileState: null,
        headCheckedAt: null,
      };
    }
    if (!chapter) {
      return {
        row,
        next: {
          ...next,
          deliverableAt: null,
          lastQueueState: MangaChapterQueueState.UNMAPPED,
          missingSince: row.missingSince ?? now,
          fileState: null,
        },
        remapped: false,
        flagged: false,
      };
    }
    const state = queueStateOf(chapter, queueById.get(chapter.id));
    const unverified = next.deliverableAt === null;
    next.lastQueueState = state;
    next.missingSince = null;
    if (unverified && state !== MangaChapterQueueState.DOWNLOADED) {
      next.fileState = null;
    }
    return {
      row,
      next,
      chapter,
      remapped,
      flagged:
        unverified &&
        state === MangaChapterQueueState.NOT_QUEUED &&
        (remapped || row.lastQueueState === MangaChapterQueueState.NOT_QUEUED),
    };
  });
};

type HeadOutcome = 'deliverable' | 'no-length' | 'empty' | 'failed';

/** Any failure the HEAD loop doesn't absorb is thrown. */
const headChapter = async (
  inst: InstanceRun,
  chapterId: string
): Promise<HeadOutcome | 'not-found'> => {
  try {
    const { contentLength } = await inst.client.headChapterArchive(chapterId, {
      signal: inst.run.signal,
    });
    if (contentLength === undefined) return 'no-length';
    return contentLength > 0 ? 'deliverable' : 'empty';
  } catch (error) {
    if (
      inst.run.signal?.aborted ||
      !(error instanceof SuwayomiError) ||
      isStop(inst.run, error)
    ) {
      throw error;
    }
    switch (error.code) {
      // L13 enforces its own size cap; the file is there.
      case 'RESPONSE_TOO_LARGE':
        return 'deliverable';
      case 'NOT_DOWNLOADED':
        return 'empty';
      case 'NOT_FOUND':
        return 'not-found';
      default:
        return 'failed';
    }
  }
};

const applyHead = (
  group: readonly PlannedRow[],
  outcome: HeadOutcome,
  now: Date
): void => {
  for (const { next } of group) {
    next.headCheckedAt = now;
    switch (outcome) {
      case 'deliverable':
        next.deliverableAt ??= now;
        next.fileState = null;
        break;
      case 'no-length':
        // A verified row stays verified; an unverified one can't be.
        if (next.deliverableAt === null) {
          next.fileState = MangaChapterFileState.NO_LENGTH;
        }
        break;
      case 'empty':
        next.deliverableAt = null;
        next.fileState =
          next.lastQueueState !== MangaChapterQueueState.DOWNLOADED
            ? null
            : next.fileState === MangaChapterFileState.EMPTY ||
                next.fileState === MangaChapterFileState.MISSING
              ? MangaChapterFileState.MISSING
              : MangaChapterFileState.EMPTY;
        break;
      case 'failed':
        break;
    }
  }
};

interface HeadResult {
  /** The HEAD budget ran out with checks still due. */
  cut: boolean;
  /** A chapter ID was stale: re-resolve before trusting this read. */
  notFound: boolean;
  /** The failure that stops the instance, after the partial results. */
  stop?: unknown;
}

/**
 * HEADs the chapters that are due, one request per chapter however many rows
 * share it, the least recently checked first, within the instance's budget.
 */
const runHeads = async (
  inst: InstanceRun,
  planned: readonly PlannedRow[],
  now: Date
): Promise<HeadResult> => {
  const groups = new Map<string, PlannedRow[]>();
  for (const plan of planned) {
    if (!plan.chapter) continue;
    groups.set(plan.next.urlHash, [
      ...(groups.get(plan.next.urlHash) ?? []),
      plan,
    ]);
  }
  const checkedAt = (group: readonly PlannedRow[]) =>
    Math.min(
      ...group.map((plan) => plan.next.headCheckedAt?.getTime() ?? -Infinity)
    );
  const firstId = (group: readonly PlannedRow[]) =>
    Math.min(...group.map((plan) => plan.row.id));
  const due = [...groups.values()]
    .filter((group) =>
      group.some((plan) => isHeadDue(plan.next, now.getTime()))
    )
    .sort(
      (left, right) =>
        checkedAt(left) - checkedAt(right) || firstId(left) - firstId(right)
    );
  for (const group of due) {
    if (inst.headsLeft <= 0) return { cut: true, notFound: false };
    inst.headsLeft -= 1;
    inst.run.counts.heads += 1;
    let outcome: HeadOutcome | 'not-found';
    try {
      outcome = await headChapter(inst, group[0].chapter!.id);
    } catch (error) {
      if (inst.run.signal?.aborted || !isStop(inst.run, error)) throw error;
      return { cut: false, notFound: false, stop: error };
    }
    if (outcome === 'not-found') return { cut: false, notFound: true };
    applyHead(group, outcome, now);
  }
  return { cut: false, notFound: false };
};

interface ManifestWrite {
  manifest: MangaRequestManifest;
  planned: readonly PlannedRow[];
  code: string | null;
  signature: string | null;
  /** The manga ID this run resolved. */
  mangaId?: number;
  /** Moves the manifest to the back of the cursor. */
  stamp: boolean;
  /** The read can complete the request: nothing in it was stale. */
  final: boolean;
}

interface OwnershipMove {
  id: number;
  from: string;
  to: string;
  url: string;
}

/**
 * L11's ownership rows follow remapped chapters, so its release still finds
 * them; a row whose new URL already has one stays where it is.
 */
const loadMoves = async (
  manager: EntityManager,
  instanceId: number,
  key: MangaKey,
  remapped: readonly PlannedRow[]
): Promise<OwnershipMove[]> => {
  const moves: OwnershipMove[] = [];
  const manga = {
    instanceId,
    sourceId: key.sourceId,
    mangaUrlHash: key.urlHash,
  };
  for (const { row, next } of remapped) {
    const owned = await manager.findOne(MangaChapterOwnership, {
      where: { ...manga, chapterUrlHash: row.urlHash },
    });
    if (
      owned &&
      !(await manager.exists(MangaChapterOwnership, {
        where: { ...manga, chapterUrlHash: next.urlHash },
      }))
    ) {
      moves.push({
        id: owned.id,
        from: row.urlHash,
        to: next.urlHash,
        url: next.url,
      });
    }
  }
  return moves;
};

/**
 * One manifest's progress, its changed rows and their ownership moves, in one
 * short transaction with no admission (R1): the reads, the instance check as
 * the last read, then a compare-and-set on the manifest still being enqueued
 * on this binding. A manifest that moved meanwhile gets nothing.
 */
const writeManifest = async (
  inst: InstanceRun,
  key: MangaKey,
  write: ManifestWrite,
  now: Date
): Promise<void> => {
  const { manifest, planned, code } = write;
  const progress = countRows(planned.map(({ next }) => next));
  const attentionAt =
    code === null
      ? null
      : code === manifest.attentionCode && manifest.attentionAt
        ? manifest.attentionAt
        : now;
  const changed = planned.filter(({ row, next }) => !isSameState(row, next));
  try {
    await dataSource.transaction(async (manager) => {
      const approved = await manager
        .createQueryBuilder(MediaRequest, 'request')
        .where('request.id = :id', { id: manifest.requestId })
        .andWhere('request.status = :status', {
          status: MediaRequestStatus.APPROVED,
        })
        .getExists();
      if (!approved) throw new ManifestMovedError();
      const moves = await loadMoves(
        manager,
        inst.instanceId,
        key,
        changed.filter(({ remapped }) => remapped)
      );
      assertSameInstance(inst.snapshot);
      const result = await manager
        .createQueryBuilder()
        .update(MangaRequestManifest)
        .set({
          chaptersTotal: progress.total,
          chaptersVerified: progress.verified,
          chaptersQueued: progress.queued,
          chaptersDownloading: progress.downloading,
          chaptersErrored: progress.errored,
          chaptersMissing: progress.missing,
          attentionCode: code,
          attentionAt,
          progressSignature: write.signature,
          ...(write.mangaId !== undefined && {
            suwayomiMangaId: write.mangaId,
          }),
          ...(write.stamp && { progressAt: now }),
        })
        .where({
          id: manifest.id,
          instanceId: inst.instanceId,
          bindingState: MangaRequestBindingState.BOUND,
          checkpoint: MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
          bindingSourceId: key.sourceId,
          bindingUrlHash: key.urlHash,
        })
        .execute();
      if (result.affected !== 1) throw new ManifestMovedError();
      for (const { row, next } of changed) {
        const updated = await manager
          .createQueryBuilder()
          .update(MangaRequestChapter)
          .set({ ...next })
          .where({ id: row.id, manifestId: manifest.id, urlHash: row.urlHash })
          .execute();
        if (updated.affected !== 1) throw new ManifestMovedError();
      }
      for (const move of moves) {
        await manager
          .createQueryBuilder()
          .update(MangaChapterOwnership)
          .set({ chapterUrlHash: move.to, chapterUrl: move.url })
          .where({ id: move.id, chapterUrlHash: move.from })
          .execute();
      }
    });
  } catch (error) {
    if (error instanceof ManifestMovedError) {
      inst.settled.add(manifest.id);
      return;
    }
    if (!isUniqueConstraintError(error)) throw error;
    // Left unsettled: the run stamps it, and a later run tries again.
    logger.warn('A manga request progress write hit a unique key', {
      label: LABEL,
      code: 'UNIQUE_CONFLICT',
      instanceId: inst.instanceId,
      manifestId: manifest.id,
    });
    return;
  }
  inst.settled.add(manifest.id);
  if (code !== manifest.attentionCode) {
    const meta = {
      label: LABEL,
      requestId: manifest.requestId,
      instanceId: inst.instanceId,
    };
    if (code) {
      logger.warn('A manga request needs attention', { ...meta, code });
    } else {
      logger.info('A manga request no longer needs attention', {
        ...meta,
        code: manifest.attentionCode,
      });
    }
  }
  if (
    write.final &&
    code === null &&
    progress.total > 0 &&
    progress.verified === progress.total
  ) {
    inst.completions.push(manifest.requestId);
  }
};

/**
 * The rows' tracker items, one per chapter of a title however many of its
 * requests share it. `seen` spans one source manga's manifests.
 */
const trackRows = (
  inst: InstanceRun,
  seen: Set<string>,
  manifest: MangaRequestManifest,
  planned: readonly PlannedRow[],
  percentFor: (plan: PlannedRow) => number | undefined
): void => {
  inst.trackedTitles.add(manifest.anilistId);
  for (const plan of planned) {
    const chapter = `${manifest.anilistId}\n${plan.next.urlHash}`;
    if (seen.has(chapter)) continue;
    const item = toTrackerItem(
      manifest.anilistId,
      plan.row,
      plan.next,
      percentFor(plan)
    );
    if (!item) continue;
    seen.add(chapter);
    inst.trackerItems.push(item);
  }
};

/**
 * Tracker items from the stored rows, when the run reads no chapter list:
 * the percents are the last read's, which the unchanged signature vouches for.
 */
const trackStored = (
  inst: InstanceRun,
  seen: Set<string>,
  manifest: MangaRequestManifest,
  planned: readonly PlannedRow[]
): void => {
  const percents = new Map<string, number>();
  for (const item of downloadTracker.getMangaProgress(
    inst.instanceId,
    manifest.anilistId
  )) {
    if (item.percent !== undefined) percents.set(item.downloadId, item.percent);
  }
  trackRows(inst, seen, manifest, planned, ({ row }) =>
    percents.get(`manga-${row.id}`)
  );
};

/** Rebuilds the instance's queue lookups from one read of the queue. */
const setQueue = (inst: InstanceRun, queue: SuwayomiQueue): void => {
  inst.queueById = new Map();
  inst.queueByManga = new Map();
  for (const item of queue.items) {
    inst.queueById.set(item.chapterId, item);
    const items = inst.queueByManga.get(item.mangaId);
    if (items) {
      items.push(item);
    } else {
      inst.queueByManga.set(item.mangaId, [item]);
    }
  }
};

/** Enqueued manifests of approved manga requests: the ones the poll owns. */
const activeManifests = () =>
  getRepository(MangaRequestManifest)
    .createQueryBuilder('manifest')
    .innerJoin('manifest.request', 'request')
    .where('request.type = :type', { type: MediaType.MANGA })
    .andWhere('request.status = :status', {
      status: MediaRequestStatus.APPROVED,
    })
    .andWhere('manifest.bindingState = :bindingState', {
      bindingState: MangaRequestBindingState.BOUND,
    })
    .andWhere('manifest.checkpoint = :checkpoint', {
      checkpoint: MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
    })
    .andWhere('manifest.bindingSourceId IS NOT NULL')
    .andWhere('manifest.bindingUrlHash IS NOT NULL');

/** A source manga's enqueued manifests, with their rows and bindings. */
const loadKey = async (inst: InstanceRun, key: MangaKey) => {
  const manifests = await activeManifests()
    .andWhere('manifest.instanceId = :instanceId', {
      instanceId: inst.instanceId,
    })
    .andWhere('manifest.bindingSourceId = :sourceId', {
      sourceId: key.sourceId,
    })
    .andWhere('manifest.bindingUrlHash = :urlHash', { urlHash: key.urlHash })
    .orderBy('manifest.id', 'ASC')
    .getMany();
  const rows = new Map<number, MangaRequestChapter[]>(
    manifests.map((manifest) => [manifest.id, []])
  );
  for (const ids of chunk([...rows.keys()], ID_SLICE)) {
    for (const row of await getRepository(MangaRequestChapter).find({
      where: { manifestId: In(ids) },
      order: { id: 'ASC' },
    })) {
      rows.get(row.manifestId)?.push(row);
    }
  }
  const bindings = await getRepository(MangaSourceBinding).find({
    where: {
      instanceId: inst.instanceId,
      sourceId: key.sourceId,
      urlHash: key.urlHash,
    },
    order: { id: 'ASC' },
  });
  return { manifests, rows, bindings };
};

/**
 * The availability the batch read for the key's manga, when its manifests
 * agree on one cached manga ID. The cache only decides whether to skip a
 * read; a read resolves the manga again by natural key.
 */
const cachedAvailability = (
  inst: InstanceRun,
  manifests: readonly MangaRequestManifest[]
): SuwayomiAvailability | undefined => {
  const ids = new Set(manifests.map((manifest) => manifest.suwayomiMangaId));
  const [id] = ids;
  return ids.size === 1 && id != null
    ? inst.availability.get(String(id))
    : undefined;
};

/**
 * One source manga, under its dispatch lock: every enqueued manifest on it,
 * from one read of its chapter lists when anything changed since the last
 * one or a file check is due.
 */
const pollKey = async (inst: InstanceRun, key: MangaKey): Promise<void> => {
  const now = new Date();
  const nowMs = now.getTime();
  const { manifests, rows, bindings } = await loadKey(inst, key);
  if (manifests.length === 0) return;
  const live = bindings.find(
    (binding) => binding.state !== MangaBindingState.REJECTED
  );
  const pairOf = (manifest: MangaRequestManifest) =>
    live?.anilistId === manifest.anilistId ? live : undefined;
  const stored = (manifest: MangaRequestManifest): PlannedRow[] =>
    (rows.get(manifest.id) ?? []).map((row) => ({
      row,
      next: stateOf(row),
      remapped: false,
      flagged:
        row.deliverableAt === null &&
        row.lastQueueState === MangaChapterQueueState.NOT_QUEUED,
    }));
  const seen = new Set<string>();
  const headDue = manifests.some((manifest) =>
    (rows.get(manifest.id) ?? []).some((row) => isHeadDue(stateOf(row), nowMs))
  );
  if (headDue && inst.headsLeft <= 0) {
    // Settled unstamped: the next run starts with these.
    for (const manifest of manifests) {
      inst.settled.add(manifest.id);
      trackStored(inst, seen, manifest, stored(manifest));
    }
    return;
  }

  const cached = cachedAvailability(inst, manifests);
  const cachedSignature = cached
    ? signatureOf(cached, inst.queueByManga.get(cached.id) ?? [])
    : null;
  if (
    cached &&
    !headDue &&
    manifests.every(
      (manifest) => manifest.progressSignature === cachedSignature
    )
  ) {
    // Nothing changed since the last read, so its rows still hold; a second
    // poll that finds a chapter not queued flags it.
    for (const manifest of manifests) {
      const planned = stored(manifest);
      await writeManifest(
        inst,
        key,
        {
          manifest,
          planned,
          code: attentionOf({
            resolved: true,
            inLibrary: cached.inLibrary,
            pair: pairOf(manifest),
            states: planned.map(({ next }) => next),
            flagged: planned.some(({ flagged }) => flagged),
            now: nowMs,
          }),
          signature: cachedSignature,
          stamp: true,
          final: true,
        },
        now
      );
      trackStored(inst, seen, manifest, planned);
    }
    return;
  }

  const url =
    bindings[0]?.url ??
    (
      await getRepository(MangaLibraryOwnership).findOne({
        where: {
          instanceId: inst.instanceId,
          sourceId: key.sourceId,
          urlHash: key.urlHash,
        },
      })
    )?.url;
  const options = { signal: inst.run.signal };
  const found =
    url === undefined
      ? undefined
      : await inst.client.findMangaByNaturalKey(key.sourceId, url, options);
  if (!found || !isSameManga(found, key)) {
    // Dispatch and the scan own the binding; the rows keep what they had.
    for (const manifest of manifests) {
      inst.trackedTitles.add(manifest.anilistId);
      await writeManifest(
        inst,
        key,
        {
          manifest,
          planned: stored(manifest),
          code: MangaAttentionCode.BINDING_ORPHANED,
          signature: null,
          stamp: true,
          final: false,
        },
        now
      );
    }
    return;
  }

  const mangaId = toStoredMangaId(found.id);
  const waiting = await inst.client.getChaptersToDownload(found.id, options);
  const downloaded = await inst.client.getDownloadedChapters(found.id, options);
  inst.run.counts.chapterReads += 1;
  const chapters = indexChapters(waiting, downloaded);
  const plan = () =>
    manifests.map((manifest) =>
      planRows(rows.get(manifest.id) ?? [], chapters, inst.queueById, now)
    );
  let plans = plan();
  if (
    plans.some((planned) =>
      planned.some(
        ({ chapter, next }) =>
          chapter !== undefined &&
          next.deliverableAt === null &&
          (next.lastQueueState === MangaChapterQueueState.ERROR ||
            next.lastQueueState === MangaChapterQueueState.NOT_QUEUED)
      )
    )
  ) {
    // The batch read the queue before this lock; dispatch may have queued
    // or retried chapters since.
    setQueue(inst, await inst.client.getQueue(options));
    plans = plan();
  }
  const heads = await runHeads(inst, plans.flat(), now);
  const stale = heads.notFound || heads.stop !== undefined;
  const signature = stale
    ? null
    : signatureOf(found, inst.queueByManga.get(found.id) ?? []);
  for (const [position, manifest] of manifests.entries()) {
    const planned = plans[position];
    await writeManifest(
      inst,
      key,
      {
        manifest,
        planned,
        code: attentionOf({
          resolved: true,
          inLibrary: found.inLibrary,
          pair: pairOf(manifest),
          states: planned.map(({ next }) => next),
          flagged: planned.some(
            ({ flagged, next }) => flagged && next.deliverableAt === null
          ),
          now: nowMs,
        }),
        signature,
        mangaId,
        stamp: !heads.cut,
        // A cut run leaves checks due; the next run starts with them.
        final: !stale && !heads.cut,
      },
      now
    );
    trackRows(inst, seen, manifest, planned, ({ chapter }) =>
      chapter ? percentOf(inst.queueById.get(chapter.id)) : undefined
    );
  }
  if (heads.stop !== undefined) throw heads.stop;
  if (
    stale ||
    !found.inLibrary ||
    live?.state !== MangaBindingState.ACTIVE ||
    !live.inLibrary
  ) {
    return;
  }
  // The scan's availability rule, from the two lists this read took.
  const all = [...chapters.byId.values()];
  const downloadCount = all.filter((chapter) => chapter.isDownloaded).length;
  const availability = computeMangaAvailability({
    chapterCount: all.length,
    downloadCount,
    hasDuplicateChapters: found.hasDuplicateChapters,
    chapterStates: all.map(({ chapterNumber, isDownloaded }) => ({
      chapterNumber,
      isDownloaded,
    })),
  });
  if (availability === 'unreadable') return;
  inst.refreshes.push({
    ...key,
    loaded: fingerprint(bindings),
    bindingId: live.id,
    anilistId: live.anilistId,
    values: {
      suwayomiMangaId: mangaId,
      chapterCount: all.length,
      downloadCount,
      availability:
        availability === 'none' ? MediaStatus.UNKNOWN : availability,
    },
  });
};

/**
 * Step 9, with no dispatch lock held (R1): writes what the reads found to the
 * bindings, fifty to a transaction under the instance's admission, each only
 * while its source manga's bindings are still what the read loaded; then
 * reconciles their titles' media. False when the instance changed.
 */
const refreshBindings = async (inst: InstanceRun): Promise<boolean> => {
  const anilistIds: number[] = [];
  const tally = newMangaMediaTally();
  try {
    for (const batch of chunk(inst.refreshes, BINDING_BATCH)) {
      inst.run.signal?.throwIfAborted();
      const titles = await runWithSuwayomiInstanceAdmission(inst.snapshot, () =>
        dataSource.transaction(async (manager) => {
          const writes: [number, Partial<MangaSourceBinding>][] = [];
          const current: number[] = [];
          for (const refresh of batch) {
            const bindings = await manager.find(MangaSourceBinding, {
              where: {
                instanceId: inst.instanceId,
                sourceId: refresh.sourceId,
                urlHash: refresh.urlHash,
              },
              order: { id: 'ASC' },
            });
            const binding = bindings.find(({ id }) => id === refresh.bindingId);
            if (!binding || fingerprint(bindings) !== refresh.loaded) continue;
            const changed = changedValues(binding, refresh.values);
            if (Object.keys(changed).length > 0) {
              writes.push([binding.id, changed]);
            }
            current.push(refresh.anilistId);
          }
          assertSameInstance(inst.snapshot);
          for (const [id, changed] of writes) {
            await manager.update(MangaSourceBinding, id, changed);
          }
          return current;
        })
      );
      anilistIds.push(...titles);
    }
    await reconcileMangaMedia(anilistIds, {
      completedInstanceIds: new Set([inst.instanceId]),
      tally,
      signal: inst.run.signal,
      snapshot: inst.snapshot,
    });
  } catch (error) {
    if (!(error instanceof SuwayomiInstanceChangedError)) throw error;
    logger.warn('Manga progress stopped on an instance', {
      label: LABEL,
      code: 'INSTANCE_CHANGED',
      instanceId: inst.instanceId,
    });
    return false;
  } finally {
    // Outside every admission; never throws.
    await enqueueMangaRequestDispatch(tally.boundRequestIds);
    if (tally.uniqueConflicts > 0 || tally.identityConflicts > 0) {
      logger.warn('Manga progress left some media unchanged', {
        label: LABEL,
        instanceId: inst.instanceId,
        uniqueConflicts: tally.uniqueConflicts,
        identityConflicts: tally.identityConflicts,
      });
    }
  }
  return true;
};

/**
 * Step 10: marks an enqueued manga request COMPLETED once every frozen
 * chapter of its manifest is verified deliverable and nothing needs
 * attention. It takes the request's admission and its media's, as
 * `dispatchRequestById` does, but no instance admission and no dispatch lock,
 * and decides again inside one transaction behind a compare-and-set on the
 * request still being APPROVED. The full save sends MEDIA_AVAILABLE once.
 */
export const completeMangaRequest = (requestId: number): Promise<boolean> =>
  runWithRequestAdmission(
    [getRequestMutationAdmissionKey(requestId)],
    async () => {
      const request = await getRepository(MediaRequest).findOne({
        where: { id: requestId },
      });
      if (
        request?.type !== MediaType.MANGA ||
        request.status !== MediaRequestStatus.APPROVED ||
        !request.media
      ) {
        return false;
      }
      // The manga admission keys come from the identifiers, which the
      // request's eager media relation does not load.
      request.media.identifiers = await getRepository(MediaIdentifier).find({
        where: { media: { id: request.media.id } },
      });
      return runMediaEntityMutation(request.media, () =>
        dataSource.transaction(async (manager) => {
          // Takes the request row first, so a concurrent writer waits or
          // this one finds the status moved.
          const touched = await manager
            .createQueryBuilder()
            .update(MediaRequest)
            .set({ status: MediaRequestStatus.APPROVED })
            .where({ id: requestId, status: MediaRequestStatus.APPROVED })
            .callListeners(false)
            .execute();
          if (touched.affected !== 1) return false;
          const fresh = await manager.findOne(MediaRequest, {
            where: { id: requestId },
          });
          const manifest = await manager.findOne(MangaRequestManifest, {
            where: {
              requestId,
              bindingState: MangaRequestBindingState.BOUND,
              checkpoint: MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
              attentionCode: IsNull(),
            },
          });
          if (!fresh?.media || !manifest) return false;
          const total = await manager.count(MangaRequestChapter, {
            where: { manifestId: manifest.id },
          });
          const unverified = await manager.count(MangaRequestChapter, {
            where: { manifestId: manifest.id, deliverableAt: IsNull() },
          });
          if (total === 0 || unverified > 0) return false;
          fresh.status = MediaRequestStatus.COMPLETED;
          await manager.save(fresh);
          return true;
        })
      );
    }
  );

/** The requests the run found fully delivered, one at a time. */
const completeRequests = async (inst: InstanceRun): Promise<void> => {
  for (const requestId of inst.completions) {
    if (inst.run.signal?.aborted) return;
    try {
      if (await completeMangaRequest(requestId)) {
        inst.run.counts.completed += 1;
      }
    } catch (error) {
      logger.warn('Manga request completion will retry', {
        label: LABEL,
        requestId,
        ...errorDetails(error),
      });
    }
  }
};

const enqueuedOn = (instanceId: number) => ({
  instanceId,
  bindingState: MangaRequestBindingState.BOUND,
  checkpoint: MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
});

/**
 * The instance is no longer configured: flag its manifests, move them to the
 * back of the cursor and clear their tracker items, without any call.
 */
const markInstanceRemoved = async (
  instanceId: number,
  manifests: readonly MangaRequestManifest[]
): Promise<void> => {
  const now = new Date();
  for (const ids of chunk(
    manifests.map(({ id }) => id),
    ID_SLICE
  )) {
    await dataSource.transaction(async (manager) => {
      const flag = { attentionCode: MangaAttentionCode.INSTANCE_REMOVED };
      for (const attentionCode of [
        IsNull(),
        Not(MangaAttentionCode.INSTANCE_REMOVED),
      ]) {
        await manager
          .createQueryBuilder()
          .update(MangaRequestManifest)
          .set({ ...flag, attentionAt: now })
          .where({ id: In(ids), ...enqueuedOn(instanceId), attentionCode })
          .execute();
      }
      await manager
        .createQueryBuilder()
        .update(MangaRequestManifest)
        .set({ progressAt: now })
        .where({ id: In(ids), ...enqueuedOn(instanceId) })
        .execute();
    });
  }
  downloadTracker.setMangaProgress(
    instanceId,
    new Set(manifests.map(({ anilistId }) => anilistId)),
    []
  );
  const raised = manifests.filter(
    ({ attentionCode }) => attentionCode !== MangaAttentionCode.INSTANCE_REMOVED
  ).length;
  if (raised > 0) {
    logger.warn('Manga requests need attention', {
      label: LABEL,
      code: MangaAttentionCode.INSTANCE_REMOVED,
      instanceId,
      count: raised,
    });
  }
};

/** Moves the selected manifests the run did not settle behind the others. */
const stampUnsettled = async (
  instanceId: number,
  manifests: readonly MangaRequestManifest[],
  settled: ReadonlySet<number>
): Promise<void> => {
  const now = new Date();
  const ids = manifests.map(({ id }) => id).filter((id) => !settled.has(id));
  for (const slice of chunk(ids, ID_SLICE)) {
    await dataSource
      .createQueryBuilder()
      .update(MangaRequestManifest)
      .set({ progressAt: now })
      .where({ id: In(slice), ...enqueuedOn(instanceId) })
      .execute();
  }
};

/** The selected manga's availability and the queue; false when it failed. */
const readAvailability = async (
  inst: InstanceRun,
  selected: readonly MangaRequestManifest[]
): Promise<boolean> => {
  const ids = [
    ...new Set(
      selected.flatMap(({ suwayomiMangaId }) =>
        suwayomiMangaId === null ? [] : [String(suwayomiMangaId)]
      )
    ),
  ];
  const options = { signal: inst.run.signal };
  try {
    for (const batch of chunk(ids, AVAILABILITY_BATCH)) {
      const { mangas, queue } = await inst.client.getAvailability(
        batch,
        options
      );
      for (const manga of mangas) inst.availability.set(manga.id, manga);
      setQueue(inst, queue);
    }
    if (ids.length === 0) setQueue(inst, await inst.client.getQueue(options));
    return true;
  } catch (error) {
    if (inst.run.signal?.aborted || !(error instanceof SuwayomiError)) {
      throw error;
    }
    logger.warn('Manga progress stopped on an instance', {
      label: LABEL,
      instanceId: inst.instanceId,
      ...errorDetails(error),
    });
    inst.run.counts.instancesFailed += 1;
    return false;
  }
};

/**
 * One instance's selected manifests: the availability and queue batch, each
 * source manga under its dispatch lock, then, holding no lock, the binding
 * refresh and the completions. The first failure that every later call would
 * hit too stops the instance.
 */
const pollInstance = async (
  run: Run,
  instanceId: number,
  selected: readonly MangaRequestManifest[]
): Promise<void> => {
  const snapshot = snapshotSuwayomiInstance(instanceId);
  if (!snapshot) {
    await markInstanceRemoved(instanceId, selected);
    return;
  }
  const settled = new Set<number>();
  try {
    const client = run.clientFor(instanceId);
    if (!client) {
      logger.warn('Manga progress stopped on an instance', {
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
      availability: new Map(),
      queueById: new Map(),
      queueByManga: new Map(),
      headsLeft: run.heads,
      settled,
      trackedTitles: new Set(),
      trackerItems: [],
      refreshes: [],
      completions: [],
    };
    if (!(await readAvailability(inst, selected))) return;
    const keys = new Map<string, MangaKey>();
    for (const { bindingSourceId, bindingUrlHash } of selected) {
      if (bindingSourceId === null || bindingUrlHash === null) continue;
      const key = { sourceId: bindingSourceId, urlHash: bindingUrlHash };
      keys.set(keyOf(key), key);
    }
    let stopped = false;
    for (const key of keys.values()) {
      run.signal?.throwIfAborted();
      try {
        await runWithMangaDispatchLock(
          instanceId,
          key.sourceId,
          key.urlHash,
          () => progressLockScope.run(true, () => pollKey(inst, key))
        );
      } catch (error) {
        if (run.signal?.aborted) throw error;
        if (isStop(run, error)) {
          logger.warn('Manga progress stopped on an instance', {
            label: LABEL,
            instanceId,
            ...errorDetails(error),
          });
          run.counts.instancesFailed += 1;
          stopped = true;
          break;
        }
        if (!(error instanceof SuwayomiError)) throw error;
        // Unsettled: stamped below, and read again on a later run.
        logger.warn('Manga progress skipped a manga', {
          label: LABEL,
          instanceId,
          ...errorDetails(error),
        });
      }
    }
    downloadTracker.setMangaProgress(
      instanceId,
      inst.trackedTitles,
      inst.trackerItems
    );
    if (stopped) return;
    if (await refreshBindings(inst)) await completeRequests(inst);
  } finally {
    if (!run.signal?.aborted) {
      await stampUnsettled(instanceId, selected, settled);
    }
  }
};

/**
 * One poll: the least recently polled enqueued manifests, up to the limit,
 * instance by instance. A failure on one instance leaves the others alone.
 */
export const pollMangaProgress = async (
  options: MangaProgressOptions = {}
): Promise<MangaProgressCounts> => {
  const limit = options.limits?.manifests ?? MANGA_PROGRESS_MANIFESTS_PER_RUN;
  const run: Run = {
    signal: options.signal,
    clientFor: options.clientFor ?? getSuwayomiClient,
    heads: options.limits?.heads ?? MANGA_PROGRESS_HEADS_PER_INSTANCE,
    counts: {
      manifests: 0,
      chapterReads: 0,
      heads: 0,
      completed: 0,
      instancesFailed: 0,
    },
  };
  const selected = await activeManifests()
    .orderBy('manifest.progressAt', 'ASC', 'NULLS FIRST')
    .addOrderBy('manifest.id', 'ASC')
    .limit(limit)
    .getMany();
  run.counts.manifests = selected.length;
  const byInstance = new Map<number, MangaRequestManifest[]>();
  for (const manifest of selected) {
    const manifests = byInstance.get(manifest.instanceId);
    if (manifests) {
      manifests.push(manifest);
    } else {
      byInstance.set(manifest.instanceId, [manifest]);
    }
  }
  for (const [instanceId, manifests] of [...byInstance].sort(
    ([left], [right]) => left - right
  )) {
    run.signal?.throwIfAborted();
    try {
      await pollInstance(run, instanceId, manifests);
    } catch (error) {
      if (run.signal?.aborted) throw error;
      logger.error('Manga progress failed on an instance', {
        label: LABEL,
        instanceId,
        ...errorDetails(error),
      });
      run.counts.instancesFailed += 1;
    }
  }
  if (selected.length < limit) {
    // The selection held every enqueued manifest: no other title is active.
    const active = new Map<number, Set<number>>();
    for (const { instanceId, anilistId } of selected) {
      active.set(
        instanceId,
        (active.get(instanceId) ?? new Set()).add(anilistId)
      );
    }
    downloadTracker.pruneMangaProgress(active);
  }
  return run.counts;
};

/** The scheduled job's runner: one poll at a time, and cancellable. */
class MangaProgressPoller {
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
      const counts = await pollMangaProgress({ signal: controller.signal });
      logger.debug('Manga progress poll finished', { label: LABEL, ...counts });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        logger.info('Manga progress poll cancelled', { label: LABEL });
      } else {
        logger.error('Manga progress poll failed', {
          label: LABEL,
          ...errorDetails(error),
        });
      }
    } finally {
      this.controller = undefined;
    }
  }
}

export const mangaProgressPoller = new MangaProgressPoller();

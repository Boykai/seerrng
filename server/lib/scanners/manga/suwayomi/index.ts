import type SuwayomiAPI from '@server/api/suwayomi';
import { SUWAYOMI_TRACKER_IDS } from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import type {
  SuwayomiLibraryItem,
  SuwayomiLibraryListing,
} from '@server/api/suwayomi/types';
import { MediaStatus } from '@server/constants/media';
import dataSource from '@server/datasource';
import MangaMatchCandidate from '@server/entity/MangaMatchCandidate';
import MangaSourceBinding, {
  MANGA_BINDING_ORIGIN_LIBRARY_SCAN,
  MANGA_MATCHED_BY_ANILIST_TRACKER,
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import type Media from '@server/entity/Media';
import { runWithRequestAdmission } from '@server/entity/MediaRequest';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import type { MangaChapterState } from '@server/lib/mangaAvailability';
import {
  computeMangaAvailability,
  needsMangaChapterStates,
} from '@server/lib/mangaAvailability';
import type { MangaBindingSummary } from '@server/lib/mangaMedia';
import {
  MANGA_IN_LIST_LIMIT,
  createMangaMedia,
  decideMangaStatus,
  findMangaMedia,
  findMediaWithActiveRequests,
  getMangaAdmissionKey,
} from '@server/lib/mangaMedia';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { runWithServarrServiceMutationAdmission } from '@server/lib/serviceAdmission';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import {
  SuwayomiInstanceChangedError,
  runWithSuwayomiInstanceAdmission,
  snapshotSuwayomiInstance,
} from '@server/lib/suwayomi/instanceAdmission';
import { chunk } from '@server/utils/chunk';
import { isUniqueConstraintError } from '@server/utils/databaseError';
import { In, type EntityManager } from 'typeorm';
import type {
  LookupBudget,
  MatchInput,
  MatchLink,
  MatchTarget,
  MatchingWarning,
  TrackerEvidence,
} from './matching';
import {
  hasTrackerConflict,
  newLookupBudget,
  resolveLibraryMatches,
} from './matching';

/** The client's limit on manga IDs per read. */
const IDS_PER_READ = 100;
/** Chapter rows per chapter-state read; a larger manga is read alone. */
const CHAPTER_ROWS_PER_READ = 5_000;
const KEYS_PER_WRITE = 100;
const MAX_TRACKER_ID = 2_147_483_647;
const NO_EVIDENCE: TrackerEvidence = {
  anilistIds: new Set(),
  malIds: new Set(),
};

export type MangaLibraryScanWarning =
  | 'UNSUPPORTED_SERVER'
  | 'PER_USER_SCHEMA'
  | 'INSTANCE_FAILED'
  | 'INSTANCE_CHANGED'
  | 'INCONSISTENT_LISTING'
  | 'SKIPPED_URL'
  | 'DUPLICATE_SOURCE_URL'
  | 'NO_TRACK_RECORDS'
  | 'TRACK_RECORDS_FAILED'
  | 'AMBIGUOUS_TRACKER_LINK'
  | 'CHAPTER_STATES_FAILED'
  | 'ROW_CHANGED'
  | 'UNIQUE_CONFLICT'
  | 'IDENTITY_CONFLICT'
  | MatchingWarning;

export interface MangaLibraryScanCounts {
  bindingsCreated: number;
  bindingsUpdated: number;
  bindingsReactivated: number;
  bindingsOrphaned: number;
  candidatesCreated: number;
  candidatesUpdated: number;
  candidatesDeleted: number;
  mediaCreated: number;
  mediaUpdated: number;
  warnings: Partial<Record<MangaLibraryScanWarning, number>>;
}

type ChangeCounter = Exclude<keyof MangaLibraryScanCounts, 'warnings'>;

export type MangaLibraryScanStatus = StatusBase & {
  counts: MangaLibraryScanCounts;
};

interface ScanRun {
  signal: AbortSignal;
  counts: MangaLibraryScanCounts;
  /** Instances whose reads and writes finished in this run. */
  completed: Set<number>;
  /** AniList IDs with a failed chapter-state read: no reconcile this run. */
  unreadable: Set<number>;
  /** Lookup calls left in this run, shared by every instance. */
  lookups: LookupBudget;
}

interface StoredRows {
  bindings: Map<string, MangaSourceBinding[]>;
  candidates: Map<string, MangaMatchCandidate>;
}

type Target =
  | { kind: 'live'; binding: MangaSourceBinding }
  | MatchTarget
  /** The tracker read failed, so nothing about the item changes this run. */
  | { kind: 'unresolved' };

interface InstanceReads {
  listing: SuwayomiLibraryListing;
  stored: StoredRows;
  targets: Map<string, Target>;
  chapterStates: Map<string, MangaChapterState[]>;
}

type WriteOp = {
  counter: ChangeCounter;
  apply: (manager: EntityManager) => Promise<unknown>;
};

interface KeyPlan {
  sourceId: string;
  url: string;
  urlHash: string;
  /** Fingerprint of the stored rows the plan was made from. */
  loaded: string;
  ops: WriteOp[];
}

const emptyCounts = (): MangaLibraryScanCounts => ({
  bindingsCreated: 0,
  bindingsUpdated: 0,
  bindingsReactivated: 0,
  bindingsOrphaned: 0,
  candidatesCreated: 0,
  candidatesUpdated: 0,
  candidatesDeleted: 0,
  mediaCreated: 0,
  mediaUpdated: 0,
  warnings: {},
});

const naturalKey = (sourceId: string, url: string) => `${sourceId}\n${url}`;

/** One source manga's stored rows, as a value a later read can compare. */
const fingerprint = (
  bindings: readonly MangaSourceBinding[] = [],
  candidate?: MangaMatchCandidate
) =>
  JSON.stringify(
    [[...bindings].sort((a, b) => a.id - b.id), candidate ?? null],
    (key, value: unknown) =>
      key === 'createdAt' || key === 'updatedAt' ? undefined : value
  );

const liveBinding = (rows: readonly MangaSourceBinding[]) =>
  rows.find((row) => row.state !== MangaBindingState.REJECTED);

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

const toTrackerId = (remoteId: string): number | undefined =>
  /^[1-9]\d{0,9}$/.test(remoteId) && Number(remoteId) <= MAX_TRACKER_ID
    ? Number(remoteId)
    : undefined;

/** Step 2: the item's own AniList tracker record. */
const trackerLink = (anilistId: number): MatchLink => ({
  kind: 'link',
  anilistId,
  confidence: MangaBindingConfidence.TRACKER_LINK,
  matchedBy: MANGA_MATCHED_BY_ANILIST_TRACKER,
});

/** Errors that fail one read batch; any other error stops the instance. */
const isBatchFailure = (error: unknown) =>
  error instanceof SuwayomiError &&
  (error.code === 'BAD_RESPONSE' || error.code === 'UPSTREAM_ERROR');

/** A stable code for logs, never upstream text. */
const failureCode = (error: unknown) =>
  error instanceof SuwayomiError
    ? error.code
    : error instanceof Error
      ? error.name
      : 'UNKNOWN';

const loadRows = async (
  manager: EntityManager,
  instanceId: number,
  urlHashes?: string[]
): Promise<StoredRows> => {
  const where = urlHashes
    ? { instanceId, urlHash: In(urlHashes) }
    : { instanceId };
  const rows: StoredRows = { bindings: new Map(), candidates: new Map() };
  for (const binding of await manager.find(MangaSourceBinding, { where })) {
    const key = naturalKey(binding.sourceId, binding.url);
    rows.bindings.set(key, [...(rows.bindings.get(key) ?? []), binding]);
  }
  for (const candidate of await manager.find(MangaMatchCandidate, { where })) {
    rows.candidates.set(
      naturalKey(candidate.sourceId, candidate.url),
      candidate
    );
  }
  return rows;
};

/** Groups manga so one read carries at most about 5,000 chapter rows. */
const chapterBatches = (items: readonly SuwayomiLibraryItem[]) => {
  const batches: SuwayomiLibraryItem[][] = [];
  let rows = 0;
  for (const item of items) {
    const current = batches[batches.length - 1];
    if (
      current &&
      current.length < IDS_PER_READ &&
      rows + item.chapterCount <= CHAPTER_ROWS_PER_READ
    ) {
      current.push(item);
      rows += item.chapterCount;
    } else {
      batches.push([item]);
      rows = item.chapterCount;
    }
  }
  return batches;
};

/**
 * Reads every configured Suwayomi library and records which AniList title
 * each source manga is and how much of it is downloaded. It sends Suwayomi
 * reads only, and calls AniList and MangaDex for matching only.
 */
class MangaLibraryScanner
  extends BaseScanner<never>
  implements RunnableScanner<MangaLibraryScanStatus>
{
  private controller?: AbortController;
  private instanceCount = 0;
  private counts = emptyCounts();

  constructor() {
    super('Manga Library Scan');
  }

  public status(): MangaLibraryScanStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.instanceCount,
      counts: this.counts,
    };
  }

  /** Also aborts the read in flight; no write follows a cancel. */
  public cancel(): void {
    super.cancel();
    this.controller?.abort();
  }

  public async run(): Promise<void> {
    if (!isMediaCategoryEnabled('manga')) {
      this.log('Manga is disabled; skipping the library scan', 'info');
      return;
    }
    const sessionId = this.startRun();
    if (!sessionId) return;
    const controller = new AbortController();
    const run: ScanRun = {
      signal: controller.signal,
      counts: emptyCounts(),
      completed: new Set(),
      unreadable: new Set(),
      lookups: newLookupBudget(),
    };
    this.controller = controller;
    this.counts = run.counts;
    try {
      const instanceIds = getExternalRuntimeConfig()
        .suwayomi.map(({ id }) => id)
        .sort((a, b) => a - b);
      this.progress = 0;
      this.instanceCount = instanceIds.length;
      await this.orphanRemovedInstances(run, new Set(instanceIds));
      for (const instanceId of instanceIds) {
        if (run.signal.aborted) break;
        await this.scanInstance(run, instanceId);
        this.progress += 1;
      }
      this.log(
        run.signal.aborted
          ? 'Manga library scan cancelled'
          : 'Manga library scan complete',
        'info',
        { ...run.counts }
      );
    } catch (error) {
      this.log('Manga library scan interrupted', 'error', {
        code: failureCode(error),
      });
    } finally {
      if (this.controller === controller) this.controller = undefined;
      this.endRun(sessionId);
    }
  }

  private warn(
    run: ScanRun,
    code: MangaLibraryScanWarning,
    instanceId: number | undefined,
    count = 1,
    cause?: string
  ): void {
    run.counts.warnings[code] = (run.counts.warnings[code] ?? 0) + count;
    this.log('Manga library scan warning', 'warn', {
      code,
      instanceId,
      count,
      cause,
    });
  }

  /**
   * Bindings of an instance that is no longer configured become ORPHANED and
   * its candidates go, without any Suwayomi call. Its titles are reconciled on
   * every run, so a downgrade that an active request or a cancel held back
   * still happens later.
   */
  private async orphanRemovedInstances(
    run: ScanRun,
    configured: ReadonlySet<number>
  ): Promise<void> {
    const stored = [
      ...(await dataSource
        .getRepository(MangaSourceBinding)
        .createQueryBuilder('binding')
        .select('binding.instanceId', 'instanceId')
        .distinct(true)
        .getRawMany<{ instanceId: unknown }>()),
      ...(await dataSource
        .getRepository(MangaMatchCandidate)
        .createQueryBuilder('candidate')
        .select('candidate.instanceId', 'instanceId')
        .distinct(true)
        .getRawMany<{ instanceId: unknown }>()),
    ];
    const removed = [...new Set(stored.map((row) => Number(row.instanceId)))]
      .filter((id) => !configured.has(id))
      .sort((a, b) => a - b);
    for (const instanceId of removed) {
      if (run.signal.aborted) return;
      try {
        const result = await runWithServarrServiceMutationAdmission(
          [{ serviceType: 'suwayomi', serviceId: instanceId }],
          async () => {
            // The instance may have been added back since the run began.
            if (
              getExternalRuntimeConfig().suwayomi.some(
                ({ id }) => id === instanceId
              )
            ) {
              return undefined;
            }
            return dataSource.transaction(async (manager) => {
              run.signal.throwIfAborted();
              const rows = await manager.find(MangaSourceBinding, {
                select: { id: true, anilistId: true, state: true },
                where: { instanceId },
              });
              const orphaned = rows.filter(
                ({ state }) => state === MangaBindingState.ACTIVE
              ).length;
              if (orphaned > 0) {
                await manager.update(
                  MangaSourceBinding,
                  { instanceId, state: MangaBindingState.ACTIVE },
                  { state: MangaBindingState.ORPHANED, inLibrary: false }
                );
              }
              const { affected } = await manager.delete(MangaMatchCandidate, {
                instanceId,
              });
              return {
                orphaned,
                deleted: affected ?? 0,
                anilistIds: rows.map(({ anilistId }) => anilistId),
              };
            });
          }
        );
        if (!result) continue;
        run.counts.bindingsOrphaned += result.orphaned;
        run.counts.candidatesDeleted += result.deleted;
        await this.reconcileMedia(run, result.anilistIds);
      } catch (error) {
        if (run.signal.aborted) return;
        this.warn(run, 'INSTANCE_FAILED', instanceId, 1, failureCode(error));
      }
    }
  }

  private async scanInstance(run: ScanRun, instanceId: number): Promise<void> {
    // The copy comes first, so a change made before the client exists still
    // fails the authority check of every write.
    const snapshot = snapshotSuwayomiInstance(instanceId);
    if (!snapshot) return;
    try {
      // Settings no client can be built from fail this instance only.
      const client = getSuwayomiClient(instanceId);
      if (!client) return;
      const reads = await this.readInstance(run, client, instanceId);
      if (!reads) return;
      const plan = this.planInstance(run, instanceId, reads);
      if (!(await this.writeInstance(run, snapshot, plan.keys))) return;
      run.completed.add(instanceId);
      await this.reconcileMedia(run, plan.anilistIds, snapshot);
    } catch (error) {
      run.completed.delete(instanceId);
      if (run.signal.aborted) return;
      if (error instanceof SuwayomiInstanceChangedError) {
        this.warn(run, 'INSTANCE_CHANGED', instanceId);
      } else {
        this.warn(run, 'INSTANCE_FAILED', instanceId, 1, failureCode(error));
      }
    }
  }

  /** Every Suwayomi read for one instance, made before any write. */
  private async readInstance(
    run: ScanRun,
    client: SuwayomiAPI,
    instanceId: number
  ): Promise<InstanceReads | undefined> {
    const options = { signal: run.signal };
    const capabilities = await client.getCapabilities(options);
    if (!capabilities.supported || capabilities.perUserDownloadState) {
      const code = capabilities.supported
        ? 'PER_USER_SCHEMA'
        : 'UNSUPPORTED_SERVER';
      this.warn(run, code, instanceId);
      return undefined;
    }
    const listing = await client.listLibrary(options);
    if (!listing.consistent) this.warn(run, 'INCONSISTENT_LISTING', instanceId);
    if (listing.skippedUrls > 0) {
      this.warn(run, 'SKIPPED_URL', instanceId, listing.skippedUrls);
    }
    if (listing.duplicateNaturalKeys > 0) {
      const count = listing.duplicateNaturalKeys;
      this.warn(run, 'DUPLICATE_SOURCE_URL', instanceId, count);
    }

    const stored = await loadRows(dataSource.manager, instanceId);
    const rowsOf = (item: SuwayomiLibraryItem) =>
      stored.bindings.get(naturalKey(item.sourceId, item.url)) ?? [];
    let links = new Map<string, TrackerEvidence | 'unresolved'>();
    if (capabilities.trackRecords) {
      const unbound = listing.items.filter(
        (item) => !liveBinding(rowsOf(item))
      );
      links = await this.readTrackerLinks(run, client, instanceId, unbound);
    } else {
      this.warn(run, 'NO_TRACK_RECORDS', instanceId);
    }

    const targets = new Map<string, Target>();
    const unmatched: MatchInput[] = [];
    let conflicts = 0;
    for (const item of listing.items) {
      const rows = rowsOf(item);
      const live = liveBinding(rows);
      const evidence = links.get(item.id) ?? NO_EVIDENCE;
      if (live) {
        targets.set(item.id, { kind: 'live', binding: live });
      } else if (evidence === 'unresolved') {
        targets.set(item.id, { kind: 'unresolved' });
      } else {
        // Without a live binding, a stored row is a rejection of that pair,
        // and a rejected pair is never bound again automatically.
        const rejected = new Set(rows.map(({ anilistId }) => anilistId));
        const [anilistId] = evidence.anilistIds;
        if (evidence.anilistIds.size === 1 && !rejected.has(anilistId)) {
          targets.set(item.id, trackerLink(anilistId));
          continue;
        }
        if (hasTrackerConflict(evidence)) conflicts += 1;
        const candidate = stored.candidates.get(
          naturalKey(item.sourceId, item.url)
        );
        unmatched.push({ item, evidence, rejected, candidate });
      }
    }
    if (conflicts > 0) {
      this.warn(run, 'AMBIGUOUS_TRACKER_LINK', instanceId, conflicts);
    }
    const matches = await resolveLibraryMatches(
      {
        signal: run.signal,
        lookups: run.lookups,
        warn: (code, count, cause) =>
          this.warn(run, code, instanceId, count, cause),
      },
      unmatched
    );
    for (const [id, target] of matches) targets.set(id, target);
    const needStates = listing.items.filter((item) => {
      const kind = targets.get(item.id)?.kind;
      return (
        (kind === 'live' || kind === 'link') && needsMangaChapterStates(item)
      );
    });
    const chapterStates = await this.readChapterStates(run, client, needStates);
    return { listing, stored, targets, chapterStates };
  }

  /** The valid AniList and MyAnimeList IDs in each item's tracker records. */
  private async readTrackerLinks(
    run: ScanRun,
    client: SuwayomiAPI,
    instanceId: number,
    items: readonly SuwayomiLibraryItem[]
  ): Promise<Map<string, TrackerEvidence | 'unresolved'>> {
    const links = new Map<string, TrackerEvidence | 'unresolved'>();
    let failed = 0;
    for (const batch of chunk(items, IDS_PER_READ)) {
      try {
        const results = await client.getTrackRecords(
          batch.map(({ id }) => id),
          { signal: run.signal }
        );
        for (const { mangaId, records } of results) {
          const ids = (trackerId: number) =>
            new Set(
              records.flatMap((record) => {
                const id =
                  record.trackerId === trackerId
                    ? toTrackerId(record.remoteId)
                    : undefined;
                return id === undefined ? [] : [id];
              })
            );
          links.set(mangaId, {
            anilistIds: ids(SUWAYOMI_TRACKER_IDS.aniList),
            malIds: ids(SUWAYOMI_TRACKER_IDS.myAnimeList),
          });
        }
      } catch (error) {
        if (!isBatchFailure(error)) throw error;
        failed += batch.length;
        for (const { id } of batch) links.set(id, 'unresolved');
      }
    }
    if (failed > 0) this.warn(run, 'TRACK_RECORDS_FAILED', instanceId, failed);
    return links;
  }

  /** A manga left out of the result, or listed short, is a failed read. */
  private async readChapterStates(
    run: ScanRun,
    client: SuwayomiAPI,
    items: readonly SuwayomiLibraryItem[]
  ): Promise<Map<string, MangaChapterState[]>> {
    const states = new Map<string, MangaChapterState[]>();
    for (const batch of chapterBatches(items)) {
      try {
        const results = await client.getLibraryChapterStates(
          batch.map(({ id }) => id),
          { signal: run.signal }
        );
        for (const { mangaId, totalCount, chapters } of results) {
          if (chapters.length === totalCount) states.set(mangaId, chapters);
        }
      } catch (error) {
        if (!isBatchFailure(error)) throw error;
      }
    }
    return states;
  }

  /** The writes one instance needs; a source manga with no change has none. */
  private planInstance(
    run: ScanRun,
    instanceId: number,
    { listing, stored, targets, chapterStates }: InstanceReads
  ): { keys: KeyPlan[]; anilistIds: number[] } {
    const keys: KeyPlan[] = [];
    const listed = new Set<string>();
    const anilistIds = new Set(
      [...stored.bindings.values()].flat().map(({ anilistId }) => anilistId)
    );
    let unreadable = 0;
    for (const item of listing.items) {
      const { sourceId, url } = item;
      const key = naturalKey(sourceId, url);
      const rows = stored.bindings.get(key) ?? [];
      const candidate = stored.candidates.get(key);
      const target: Target = targets.get(item.id) ?? { kind: 'unresolved' };
      const urlHash = hashMangaSourceUrl(url);
      const ops: WriteOp[] = [];
      listed.add(key);
      if (target.kind === 'candidate') {
        const values = {
          suwayomiMangaId: Number(item.id),
          title: item.title,
          ...target.progress,
        };
        if (!candidate) {
          ops.push({
            counter: 'candidatesCreated',
            apply: (manager) =>
              manager.insert(MangaMatchCandidate, {
                instanceId,
                sourceId,
                url,
                urlHash,
                ...values,
              }),
          });
        } else {
          const changed = changedValues(candidate, values);
          if (Object.keys(changed).length > 0) {
            ops.push({
              counter: 'candidatesUpdated',
              apply: (manager) =>
                manager.update(MangaMatchCandidate, candidate.id, changed),
            });
          }
        }
      } else if (target.kind !== 'unresolved') {
        const anilistId =
          target.kind === 'live' ? target.binding.anilistId : target.anilistId;
        const availability = computeMangaAvailability({
          ...item,
          chapterStates: chapterStates.get(item.id),
        });
        if (availability === 'unreadable') {
          unreadable += 1;
          run.unreadable.add(anilistId);
        }
        // Counts and availability change together, from one consistent read.
        const values: Partial<MangaSourceBinding> = {
          state: MangaBindingState.ACTIVE,
          inLibrary: true,
          suwayomiMangaId: Number(item.id),
          title: item.title,
          ...(availability !== 'unreadable' && {
            chapterCount: item.chapterCount,
            downloadCount: item.downloadCount,
            availability:
              availability === 'none' ? MediaStatus.UNKNOWN : availability,
          }),
        };
        if (target.kind === 'live') {
          const { binding } = target;
          const changed = changedValues(binding, values);
          if (Object.keys(changed).length > 0) {
            ops.push({
              counter:
                binding.state === MangaBindingState.ORPHANED
                  ? 'bindingsReactivated'
                  : 'bindingsUpdated',
              apply: (manager) =>
                manager.update(MangaSourceBinding, binding.id, changed),
            });
          }
        } else {
          anilistIds.add(anilistId);
          const { confidence, matchedBy } = target;
          ops.push({
            counter: 'bindingsCreated',
            apply: (manager) =>
              manager.insert(MangaSourceBinding, {
                instanceId,
                sourceId,
                url,
                urlHash,
                anilistId,
                confidence,
                matchedBy,
                origin: MANGA_BINDING_ORIGIN_LIBRARY_SCAN,
                chapterCount: null,
                downloadCount: null,
                availability: MediaStatus.UNKNOWN,
                ...values,
              }),
          });
        }
        if (candidate) {
          ops.push({
            counter: 'candidatesDeleted',
            apply: (manager) =>
              manager.delete(MangaMatchCandidate, candidate.id),
          });
        }
      }
      if (ops.length > 0) {
        const loaded = fingerprint(rows, candidate);
        keys.push({ sourceId, url, urlHash, loaded, ops });
      }
    }
    if (unreadable > 0) {
      this.warn(run, 'CHAPTER_STATES_FAILED', instanceId, unreadable);
    }

    // Only a complete, consistent listing shows that an item left.
    if (listing.consistent) {
      const vanished = new Set(
        [...stored.bindings.keys(), ...stored.candidates.keys()].filter(
          (key) => !listed.has(key)
        )
      );
      for (const key of vanished) {
        const rows = stored.bindings.get(key) ?? [];
        const candidate = stored.candidates.get(key);
        const live = rows.find(
          (row) => row.state === MangaBindingState.ACTIVE && row.inLibrary
        );
        const ops: WriteOp[] = [];
        if (live) {
          ops.push({
            counter: 'bindingsOrphaned',
            apply: (manager) =>
              manager.update(MangaSourceBinding, live.id, {
                state: MangaBindingState.ORPHANED,
                inLibrary: false,
              }),
          });
        }
        if (candidate) {
          ops.push({
            counter: 'candidatesDeleted',
            apply: (manager) =>
              manager.delete(MangaMatchCandidate, candidate.id),
          });
        }
        const row = live ?? candidate;
        if (row) {
          const { sourceId, url, urlHash } = row;
          const loaded = fingerprint(rows, candidate);
          keys.push({ sourceId, url, urlHash, loaded, ops });
        }
      }
    }
    return { keys, anilistIds: [...anilistIds] };
  }

  /**
   * Writes the plan in batches, each under the instance's admission and in
   * one transaction. A source manga whose rows changed since they were read
   * is skipped, as is one whose write hits a unique key. Returns false when
   * the writes stopped early.
   */
  private async writeInstance(
    run: ScanRun,
    snapshot: SuwayomiSettings,
    keys: readonly KeyPlan[]
  ): Promise<boolean> {
    let changed = 0;
    let conflicts = 0;
    try {
      for (const batch of chunk(keys, KEYS_PER_WRITE)) {
        if (run.signal.aborted) return false;
        const result = await runWithSuwayomiInstanceAdmission(snapshot, () =>
          dataSource.transaction(async (manager) => {
            const fresh = await loadRows(
              manager,
              snapshot.id,
              batch.map(({ urlHash }) => urlHash)
            );
            const counters: ChangeCounter[] = [];
            let skipped = 0;
            let failed = 0;
            for (const plan of batch) {
              run.signal.throwIfAborted();
              const key = naturalKey(plan.sourceId, plan.url);
              const current = fingerprint(
                fresh.bindings.get(key),
                fresh.candidates.get(key)
              );
              if (current !== plan.loaded) {
                skipped += 1;
                continue;
              }
              try {
                // A nested transaction is a savepoint: a conflict undoes only
                // this source manga's writes.
                await manager.transaction(async (savepoint) => {
                  for (const op of plan.ops) await op.apply(savepoint);
                });
                counters.push(...plan.ops.map((op) => op.counter));
              } catch (error) {
                if (!isUniqueConstraintError(error)) throw error;
                failed += 1;
              }
            }
            return { counters, skipped, failed };
          })
        );
        for (const counter of result.counters) run.counts[counter] += 1;
        changed += result.skipped;
        conflicts += result.failed;
      }
    } catch (error) {
      if (!(error instanceof SuwayomiInstanceChangedError)) throw error;
      this.warn(run, 'INSTANCE_CHANGED', snapshot.id);
      return false;
    } finally {
      if (changed > 0) this.warn(run, 'ROW_CHANGED', snapshot.id, changed);
      if (conflicts > 0) {
        this.warn(run, 'UNIQUE_CONFLICT', snapshot.id, conflicts);
      }
    }
    return !run.signal.aborted;
  }

  /**
   * Brings each title's media status in line with its bindings. Decisions are
   * made in bulk; a mismatch takes the locks and is decided again inside
   * them before anything is written.
   */
  private async reconcileMedia(
    run: ScanRun,
    anilistIds: readonly number[],
    snapshot?: SuwayomiSettings
  ): Promise<void> {
    const ids = [...new Set(anilistIds)]
      .filter((id) => !run.unreadable.has(id))
      .sort((a, b) => a - b);
    let conflicts = 0;
    let identityConflicts = 0;
    try {
      for (const slice of chunk(ids, MANGA_IN_LIST_LIMIT)) {
        if (run.signal.aborted) return;
        const decided = await this.decideMedia(
          dataSource.manager,
          slice,
          run.completed
        );
        identityConflicts += decided.conflicts;
        for (const anilistId of decided.changes.keys()) {
          // Request admission, then the scan lock, then the instance's
          // admission, then the transaction.
          const write = () =>
            dataSource.transaction((manager) => {
              run.signal.throwIfAborted();
              return this.applyMediaChange(manager, anilistId, run.completed);
            });
          try {
            const counter = await runWithRequestAdmission(
              [getMangaAdmissionKey(anilistId)],
              () =>
                this.asyncLock.dispatch(`manga:anilist:${anilistId}`, () =>
                  snapshot
                    ? runWithSuwayomiInstanceAdmission(snapshot, write)
                    : write()
                )
            );
            if (counter) run.counts[counter] += 1;
          } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            conflicts += 1;
          }
        }
      }
    } finally {
      const instanceId = snapshot?.id;
      if (conflicts > 0) {
        this.warn(run, 'UNIQUE_CONFLICT', instanceId, conflicts);
      }
      if (identityConflicts > 0) {
        this.warn(run, 'IDENTITY_CONFLICT', instanceId, identityConflicts);
      }
    }
  }

  private async applyMediaChange(
    manager: EntityManager,
    anilistId: number,
    completed: ReadonlySet<number>
  ): Promise<ChangeCounter | undefined> {
    const { changes } = await this.decideMedia(manager, [anilistId], completed);
    const change = changes.get(anilistId);
    if (!change) return undefined;
    if (!change.media) {
      await createMangaMedia(manager, anilistId, change.status);
      return 'mediaCreated';
    }
    change.media.status = change.status;
    await manager.save(change.media);
    return 'mediaUpdated';
  }

  /** The statuses to write, by AniList ID, for at most 500 IDs. */
  private async decideMedia(
    manager: EntityManager,
    anilistIds: readonly number[],
    completed: ReadonlySet<number>
  ) {
    const bindings = new Map<number, MangaBindingSummary[]>();
    const rows = await manager.find(MangaSourceBinding, {
      select: {
        id: true,
        anilistId: true,
        instanceId: true,
        state: true,
        inLibrary: true,
        availability: true,
      },
      where: { anilistId: In([...anilistIds]) },
    });
    for (const row of rows) {
      bindings.set(row.anilistId, [
        ...(bindings.get(row.anilistId) ?? []),
        row,
      ]);
    }
    const media = await findMangaMedia(manager, anilistIds);
    const active = await findMediaWithActiveRequests(
      manager,
      [...media.values()].flatMap((found) => (found ? [found.id] : []))
    );
    const changes = new Map<
      number,
      { media: Media | undefined; status: MediaStatus }
    >();
    let conflicts = 0;
    for (const anilistId of anilistIds) {
      const found = media.get(anilistId);
      if (found === null) {
        conflicts += 1;
        continue;
      }
      const status = decideMangaStatus({
        current: found?.status,
        bindings: bindings.get(anilistId) ?? [],
        completedInstanceIds: completed,
        activeRequest: found !== undefined && active.has(found.id),
      });
      if (status !== undefined) {
        changes.set(anilistId, { media: found, status });
      }
    }
    return { changes, conflicts };
  }
}

export const mangaLibraryScanner = new MangaLibraryScanner();

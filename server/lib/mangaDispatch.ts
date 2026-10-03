import type SuwayomiAPI from '@server/api/suwayomi';
import {
  SuwayomiError,
  isRecord,
  type SuwayomiErrorCode,
} from '@server/api/suwayomi/errors';
import { META_VALUE_LIMIT } from '@server/api/suwayomi/mappers';
import { REQUEST_STAMP_KEY } from '@server/api/suwayomi/operations';
import type {
  SuwayomiCallOptions,
  SuwayomiChapter,
  SuwayomiFetchResult,
  SuwayomiMangaDetails,
} from '@server/api/suwayomi/types';
import {
  MANGA_DISPATCH_CATEGORY,
  MANGA_DISPATCH_WAIT_MS,
  MANGA_SOURCE_FETCH_ATTEMPTS,
  MangaDispatchError,
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
import MangaInstanceMarker from '@server/entity/MangaInstanceMarker';
import MangaLibraryOwnership from '@server/entity/MangaLibraryOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MANGA_BINDING_ORIGIN_ADMIN,
  MANGA_LIVE_BINDING_STATES,
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import {
  buildMangaRequestChapterRows,
  getNextMangaRequestCheckpoint,
  selectMangaManifestChapters,
  type MangaChapterCandidate,
} from '@server/lib/mangaRequests';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import type { RequestDispatchOutcome } from '@server/lib/requestDispatch';
import { hasSameServarrServiceAuthority } from '@server/lib/serviceAdmission';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import {
  SuwayomiInstanceChangedError,
  snapshotSuwayomiInstance,
} from '@server/lib/suwayomi/instanceAdmission';
import logger from '@server/logger';
import AsyncLock from '@server/utils/asyncLock';
import { chunk } from '@server/utils/chunk';
import { randomUUID } from 'node:crypto';
import { In, IsNull, type EntityManager } from 'typeorm';

const LABEL = 'Manga Dispatch';
/** Bindings tried per run before the request waits. */
const MAX_BINDING_LOOKUPS = 5;
/** More than the seven steps; a run that keeps losing its manifest stops. */
const MAX_STEPS_PER_RUN = 16;
/** Chapter IDs per enqueue or dequeue call. */
const QUEUE_BATCH_SIZE = 50;
const INSERT_SLICE = 100;
const ID_SLICE = 500;
/** Chapter ownership rows the release looks at per sweep. */
const RELEASE_SCAN_LIMIT = 500;
/** Request-index entries the release drops per instance and sweep. */
const MIRROR_RELEASE_LIMIT = 50;
const MAX_SUWAYOMI_INT = 2_147_483_647;
const MARKER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const MANGA_DISPATCH_SWEEP_LIMIT = 50;
export const MAX_MANGA_DISPATCH_SWEEP_LIMIT = 500;

const AUTH_CODES = new Set<SuwayomiErrorCode>([
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'AUTH_MODE_UNSUPPORTED',
  'AUTH_MODE_MISMATCH',
]);

const CONFIDENCE_RANK: Record<MangaBindingConfidence, number> = {
  [MangaBindingConfidence.EXACT_LINK]: 0,
  [MangaBindingConfidence.TRACKER_LINK]: 1,
  [MangaBindingConfidence.MANUAL]: 2,
  [MangaBindingConfidence.HIGH]: 3,
  [MangaBindingConfidence.MEDIUM]: 4,
  [MangaBindingConfidence.LOW]: 5,
};

/** Media statuses an enqueued request raises to PROCESSING. */
const STATUSES_BELOW_PROCESSING = new Set<MediaStatus>([
  MediaStatus.UNKNOWN,
  MediaStatus.PENDING,
  MediaStatus.DELETED,
]);

/** Waits that need no one's attention log at info, not warn. */
const QUIET_CODES = new Set<MangaDispatchError>([
  MangaDispatchError.BINDING_MISSING,
  MangaDispatchError.BINDING_UNCONFIRMED,
  MangaDispatchError.NO_MATCHING_CHAPTERS,
]);

const DELIVERED: RequestDispatchOutcome = { delivered: true };

export interface MangaDispatchOptions {
  signal?: AbortSignal;
  /** Replaces the shared client factory; tests pass their own client. */
  clientFor?: (instanceId: number) => SuwayomiAPI | undefined;
}

interface DispatchTarget {
  requestId: number;
  manifestId: number;
}

interface DispatchContext extends DispatchTarget {
  mediaId: number | undefined;
  instanceId: number;
  /** The instance's settings, copied before its client was built. */
  snapshot: SuwayomiSettings;
  client: SuwayomiAPI;
  call: SuwayomiCallOptions;
  signal?: AbortSignal;
  /** The chapter list this run fetched, kept for the freeze. */
  chapters?: SuwayomiChapter[];
}

/** A source manga on one instance: the dispatch lock's key. */
interface MangaKey {
  instanceId: number;
  sourceId: string;
  urlHash: string;
}

interface ResolvedBinding extends MangaKey {
  url: string;
  /** The Suwayomi manga ID, resolved by natural key on this run. */
  mangaId: string;
  /** The manga an unfrozen request left on this run; its stamp still names it. */
  previousMangaId?: string;
}

/** Rolls a transaction back when its manifest moved under it. */
class ManifestMovedError extends Error {}

const dispatchLocks = new AsyncLock();

/**
 * Serializes work on one source manga of one instance: dispatch steps, and
 * the release's dequeues and stamp rewrites. In-process only; take it
 * outside any transaction and never inside itself.
 */
export const runWithMangaDispatchLock = <Result>(
  instanceId: number,
  sourceId: string,
  urlHash: string,
  callback: () => Promise<Result>
): Promise<Result> =>
  dispatchLocks.dispatch(
    `manga:${instanceId}:${sourceId}:${urlHash}`,
    callback
  );

/**
 * Throws unless the instance still has the address and login the snapshot
 * was taken with. Each write transaction calls it as its last read before
 * writing, so a checkpoint never records work done on another server.
 */
const assertSameInstance = (snapshot: SuwayomiSettings): void => {
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

/**
 * Records why the run stopped. A wait leaves the outbox and sets the time the
 * sweep may try again; a failure counts an attempt and lets the outbox retry
 * with its backoff.
 */
const settle = async (
  target: DispatchTarget,
  code: MangaDispatchError,
  { waitMs, countAttempt = false }: { waitMs?: number; countAttempt?: boolean },
  details: Record<string, unknown> = {}
): Promise<RequestDispatchOutcome> => {
  await getRepository(MangaRequestManifest)
    .createQueryBuilder()
    .update(MangaRequestManifest)
    .set({
      lastError: code,
      ...(countAttempt ? { attempts: () => '"attempts" + 1' } : {}),
      ...(waitMs !== undefined
        ? { retryNotBefore: new Date(Date.now() + waitMs) }
        : {}),
    })
    .where({ id: target.manifestId })
    .execute();
  const level =
    code === MangaDispatchError.DISPATCH_ERROR
      ? 'error'
      : QUIET_CODES.has(code)
        ? 'info'
        : 'warn';
  logger[level](
    waitMs !== undefined
      ? 'Manga request dispatch is waiting'
      : 'Manga request dispatch will retry',
    { label: LABEL, requestId: target.requestId, code, ...details }
  );
  return waitMs !== undefined ? DELIVERED : { delivered: false };
};

const settleError = (
  target: DispatchTarget,
  error: unknown
): Promise<RequestDispatchOutcome> => {
  const details = errorDetails(error);
  if (error instanceof SuwayomiInstanceChangedError) {
    return settle(
      target,
      MangaDispatchError.INSTANCE_CHANGED,
      { countAttempt: true },
      details
    );
  }
  if (error instanceof SuwayomiError) {
    if (error.retryable || error.code === 'ABORTED') {
      return settle(
        target,
        MangaDispatchError.SUWAYOMI_UNAVAILABLE,
        { countAttempt: true },
        details
      );
    }
    if (error.code === 'NOT_FOUND') {
      return settle(
        target,
        MangaDispatchError.BINDING_MISSING,
        { countAttempt: true },
        details
      );
    }
    const code = AUTH_CODES.has(error.code)
      ? MangaDispatchError.SUWAYOMI_AUTH
      : error.code === 'UNSUPPORTED_SERVER'
        ? MangaDispatchError.SUWAYOMI_UNSUPPORTED
        : MangaDispatchError.SUWAYOMI_ERROR;
    return settle(
      target,
      code,
      { waitMs: MANGA_DISPATCH_WAIT_MS.attention },
      details
    );
  }
  if (isAbortError(error)) {
    return settle(
      target,
      MangaDispatchError.SUWAYOMI_UNAVAILABLE,
      { countAttempt: true },
      details
    );
  }
  return settle(
    target,
    MangaDispatchError.DISPATCH_ERROR,
    { countAttempt: true },
    details
  );
};

/** A Suwayomi manga ID as the manifest stores it. */
const toStoredMangaId = (mangaId: string): number => {
  const value = Number(mangaId);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SUWAYOMI_INT) {
    throw new SuwayomiError('BAD_RESPONSE', 'ByNaturalKey');
  }
  return value;
};

const isAdminBinding = (binding: MangaSourceBinding): boolean =>
  binding.origin === MANGA_BINDING_ORIGIN_ADMIN;

/** An admin's binding at any confidence, any other at HIGH or above. */
const isDispatchableBinding = (binding: MangaSourceBinding): boolean =>
  isAdminBinding(binding) ||
  CONFIDENCE_RANK[binding.confidence] <=
    CONFIDENCE_RANK[MangaBindingConfidence.HIGH];

/**
 * The order a title's bindings are tried in: one already in the library,
 * then an admin's over an automatic one, then the oldest.
 */
const compareBindings = (
  left: MangaSourceBinding,
  right: MangaSourceBinding
): number =>
  Number(right.inLibrary) - Number(left.inLibrary) ||
  Number(isAdminBinding(right)) - Number(isAdminBinding(left)) ||
  left.id - right.id;

const isSameManga = (
  details: Pick<SuwayomiMangaDetails, 'sourceId' | 'url'>,
  key: Pick<MangaKey, 'sourceId' | 'urlHash'>
): boolean =>
  details.sourceId === key.sourceId &&
  hashMangaSourceUrl(details.url) === key.urlHash;

/**
 * Records the step after the manifest's checkpoint, only while the manifest
 * is still BOUND at that checkpoint. Returns whether it was recorded.
 */
const advanceIn = async (
  manager: EntityManager,
  manifest: MangaRequestManifest,
  freeze = false
): Promise<boolean> => {
  const next = getNextMangaRequestCheckpoint(manifest.checkpoint);
  if (!next) {
    return false;
  }
  const result = await manager
    .createQueryBuilder()
    .update(MangaRequestManifest)
    .set({
      checkpoint: next,
      checkpointAt: () => 'CURRENT_TIMESTAMP',
      attempts: 0,
      lastError: null,
      retryNotBefore: null,
      ...(freeze ? { frozenAt: () => 'CURRENT_TIMESTAMP' } : {}),
    })
    .where({
      id: manifest.id,
      bindingState: MangaRequestBindingState.BOUND,
      checkpoint: manifest.checkpoint === null ? IsNull() : manifest.checkpoint,
    })
    .execute();
  return result.affected === 1;
};

const advance = (
  context: DispatchContext,
  manifest: MangaRequestManifest
): Promise<boolean> =>
  dataSource.transaction(async (manager) => {
    assertSameInstance(context.snapshot);
    return advanceIn(manager, manifest);
  });

/**
 * Starts an unfrozen request over. Without `waitMs` it is parked, as the
 * binding sync parks a title with no ACTIVE binding. A title whose bindings
 * name no manga the server has stays bound for `waitMs` instead: the sync
 * would bind a parked request again at once. A manifest parked or frozen
 * meanwhile is left alone.
 */
const startOver = async (
  context: DispatchContext,
  waitMs?: number
): Promise<void> => {
  const changed = await dataSource.transaction(async (manager) => {
    assertSameInstance(context.snapshot);
    const result = await manager
      .createQueryBuilder()
      .update(MangaRequestManifest)
      .set({
        ...(waitMs === undefined && {
          bindingState: MangaRequestBindingState.AWAITING_BINDING,
          boundAt: null,
        }),
        checkpoint: null,
        checkpointAt: null,
        lastError: MangaDispatchError.BINDING_MISSING,
        attempts: 0,
        retryNotBefore:
          waitMs === undefined ? null : new Date(Date.now() + waitMs),
      })
      .where({
        id: context.manifestId,
        bindingState: MangaRequestBindingState.BOUND,
        frozenAt: IsNull(),
      })
      .execute();
    return result.affected === 1;
  });
  if (!changed) {
    return;
  }
  logger.info(
    waitMs === undefined
      ? 'Manga request parked until its title is bound again'
      : 'Manga request dispatch is waiting',
    {
      label: LABEL,
      requestId: context.requestId,
      code: MangaDispatchError.BINDING_MISSING,
    }
  );
};

/**
 * Stores the resolved binding and manga ID. Another binding than the one
 * recorded restarts the steps; that is only allowed before the freeze.
 * Returns undefined when the manifest is no longer BOUND (or was frozen).
 */
const recordBinding = async (
  context: DispatchContext,
  manifest: MangaRequestManifest,
  binding: ResolvedBinding
): Promise<ResolvedBinding | undefined> => {
  const suwayomiMangaId = toStoredMangaId(binding.mangaId);
  const rebound =
    manifest.bindingSourceId !== binding.sourceId ||
    manifest.bindingUrlHash !== binding.urlHash;
  if (!rebound && manifest.suwayomiMangaId === suwayomiMangaId) {
    return binding;
  }
  const recorded = await dataSource.transaction(async (manager) => {
    assertSameInstance(context.snapshot);
    const result = await manager
      .createQueryBuilder()
      .update(MangaRequestManifest)
      .set(
        rebound
          ? {
              bindingSourceId: binding.sourceId,
              bindingUrlHash: binding.urlHash,
              suwayomiMangaId,
              checkpoint: null,
              checkpointAt: null,
              attempts: 0,
              lastError: null,
            }
          : { suwayomiMangaId }
      )
      .where({
        id: manifest.id,
        bindingState: MangaRequestBindingState.BOUND,
        ...(rebound ? { frozenAt: IsNull() } : {}),
      })
      .execute();
    return result.affected === 1;
  });
  if (!recorded) {
    return undefined;
  }
  return rebound && manifest.suwayomiMangaId !== null
    ? { ...binding, previousMangaId: String(manifest.suwayomiMangaId) }
    : binding;
};

/**
 * Step 1, run every time: picks the title's ACTIVE binding on the target
 * instance and resolves its Suwayomi manga by natural key. After the freeze
 * only the recorded binding counts.
 */
const resolveBinding = async (
  context: DispatchContext,
  manifest: MangaRequestManifest
): Promise<ResolvedBinding | RequestDispatchOutcome> => {
  const frozen = manifest.frozenAt != null;
  if (frozen && (!manifest.bindingSourceId || !manifest.bindingUrlHash)) {
    return settle(context, MangaDispatchError.BINDING_MISSING, {
      waitMs: MANGA_DISPATCH_WAIT_MS.binding,
    });
  }
  const rows = await getRepository(MangaSourceBinding).find({
    where: {
      anilistId: manifest.anilistId,
      instanceId: manifest.instanceId,
      state: MangaBindingState.ACTIVE,
      ...(frozen
        ? {
            sourceId: manifest.bindingSourceId as string,
            urlHash: manifest.bindingUrlHash as string,
          }
        : {}),
    },
  });
  const eligible = rows.filter(isDispatchableBinding).sort(compareBindings);
  if (rows.length > 0 && eligible.length === 0) {
    return settle(context, MangaDispatchError.BINDING_UNCONFIRMED, {
      waitMs: MANGA_DISPATCH_WAIT_MS.binding,
    });
  }
  for (const row of eligible.slice(0, MAX_BINDING_LOOKUPS)) {
    const found = await context.client.findMangaByNaturalKey(
      row.sourceId,
      row.url,
      context.call
    );
    if (!found) {
      continue;
    }
    const binding: ResolvedBinding = {
      instanceId: context.instanceId,
      sourceId: row.sourceId,
      urlHash: row.urlHash,
      url: row.url,
      mangaId: found.id,
    };
    return (await recordBinding(context, manifest, binding)) ?? DELIVERED;
  }
  // Only a server that carries this instance's marker can say a manga is gone.
  const mismatch =
    eligible.length > 0 ? await verifyInstanceMarker(context) : undefined;
  if (mismatch) {
    return mismatch;
  }
  if (frozen) {
    return settle(context, MangaDispatchError.BINDING_MISSING, {
      waitMs: MANGA_DISPATCH_WAIT_MS.binding,
    });
  }
  await startOver(
    context,
    eligible.length > 0 ? MANGA_DISPATCH_WAIT_MS.binding : undefined
  );
  return DELIVERED;
};

const instanceMismatch = (
  context: DispatchContext
): Promise<RequestDispatchOutcome> =>
  settle(context, MangaDispatchError.INSTANCE_MISMATCH, {
    waitMs: MANGA_DISPATCH_WAIT_MS.attention,
  });

/**
 * Step 2, run every time: the server must carry this instance's marker before
 * anything is written to it. An unmarked server gets the marker; a server
 * marked by an instance that is no longer configured is adopted; any other
 * marker stops the request without a write. Anything but this instance's own
 * marker is decided again under one lock for all instances, so two instances
 * on one server cannot both mark it.
 */
const verifyInstanceMarker = async (
  context: DispatchContext
): Promise<RequestDispatchOutcome | undefined> => {
  const stored = await getRepository(MangaInstanceMarker).findOne({
    where: { instanceId: context.instanceId },
  });
  if (
    stored &&
    (await context.client.getInstanceMarker(context.call)) === stored.marker
  ) {
    return undefined;
  }
  return dispatchLocks.dispatch('marker', async () => {
    const { client, call, instanceId } = context;
    const markers = getRepository(MangaInstanceMarker);
    const own = await markers.findOne({ where: { instanceId } });
    const current = await client.getInstanceMarker(call);
    if (own) {
      if (current === own.marker) {
        return undefined;
      }
      if (current !== undefined) {
        return instanceMismatch(context);
      }
      await client.setInstanceMarker(own.marker, call);
      return undefined;
    }
    if (current === undefined) {
      await dataSource.transaction(async (manager) => {
        assertSameInstance(context.snapshot);
        await manager
          .createQueryBuilder()
          .insert()
          .into(MangaInstanceMarker)
          .values({ instanceId, marker: randomUUID() })
          .orIgnore()
          .execute();
      });
      const created = await markers.findOneOrFail({ where: { instanceId } });
      await client.setInstanceMarker(created.marker, call);
      return undefined;
    }
    if (!MARKER_PATTERN.test(current)) {
      return instanceMismatch(context);
    }
    const holder = await markers.findOne({ where: { marker: current } });
    if (
      !holder ||
      getExternalRuntimeConfig().suwayomi.some(
        (instance) => instance.id === holder.instanceId
      )
    ) {
      return instanceMismatch(context);
    }
    const adopted = await dataSource.transaction(async (manager) => {
      assertSameInstance(context.snapshot);
      const result = await manager
        .createQueryBuilder()
        .update(MangaInstanceMarker)
        .set({ instanceId })
        .where({ marker: current, instanceId: holder.instanceId })
        .execute();
      return result.affected === 1;
    });
    if (!adopted) {
      return instanceMismatch(context);
    }
    logger.info('Suwayomi instance took over a removed instance marker', {
      label: LABEL,
      instanceId,
      previousInstanceId: holder.instanceId,
    });
    return undefined;
  });
};

/** The approved requests whose manifests point at this source manga. */
const findStampRequestIds = async (key: MangaKey): Promise<number[]> => {
  const rows = await getRepository(MangaRequestManifest)
    .createQueryBuilder('manifest')
    .innerJoin(MediaRequest, 'request', 'request.id = manifest.requestId')
    .select('manifest.requestId', 'requestId')
    .where('manifest.instanceId = :instanceId', { instanceId: key.instanceId })
    .andWhere('manifest.bindingSourceId = :sourceId', {
      sourceId: key.sourceId,
    })
    .andWhere('manifest.bindingUrlHash = :urlHash', { urlHash: key.urlHash })
    .andWhere('request.type = :type', { type: MediaType.MANGA })
    .andWhere('request.status = :status', {
      status: MediaRequestStatus.APPROVED,
    })
    .getRawMany<{ requestId: number | string }>();
  return rows.map(({ requestId }) => Number(requestId));
};

/**
 * The request stamp, built from the database alone: Suwayomi's copy is a
 * mirror and is never read back into it. When the IDs don't fit the meta
 * limit the oldest go first; `currentRequestId` always stays.
 */
const buildRequestStamp = async (
  key: MangaKey,
  currentRequestId?: number
): Promise<string> => {
  const [requestIds, ownership, binding] = await Promise.all([
    findStampRequestIds(key),
    getRepository(MangaLibraryOwnership).findOne({
      where: {
        instanceId: key.instanceId,
        sourceId: key.sourceId,
        urlHash: key.urlHash,
      },
    }),
    getRepository(MangaSourceBinding).findOne({
      select: { id: true, anilistId: true },
      where: {
        instanceId: key.instanceId,
        sourceId: key.sourceId,
        urlHash: key.urlHash,
        state: In([...MANGA_LIVE_BINDING_STATES]),
      },
    }),
  ]);
  const render = (ids: readonly number[]) =>
    JSON.stringify({
      v: 1,
      requestIds: ids,
      addedBySeerrng: ownership?.addedBySeerrng ?? false,
      anilistId: binding?.anilistId ?? null,
    });
  const kept = currentRequestId !== undefined ? [currentRequestId] : [];
  let length = render(kept).length;
  for (const id of [...new Set(requestIds)].sort((a, b) => b - a)) {
    if (id === currentRequestId) {
      continue;
    }
    // Each ID adds its digits and at most one comma.
    const added = String(id).length + 1;
    if (length + added > META_VALUE_LIMIT) {
      break;
    }
    kept.push(id);
    length += added;
  }
  return render(kept.sort((a, b) => a - b));
};

/** The request-index entry: where the request's manga is on the server. */
const buildRequestIndexValue = (binding: ResolvedBinding): string => {
  const mangaId = toStoredMangaId(binding.mangaId);
  const value = JSON.stringify({
    sourceId: binding.sourceId,
    url: binding.url,
    mangaId,
  });
  return value.length <= META_VALUE_LIMIT
    ? value
    : JSON.stringify({ sourceId: binding.sourceId, mangaId });
};

/**
 * Step 3: records who owns the library entry before SeerrNG adds it, so a
 * crash in between never turns a user's entry into SeerrNG's.
 */
const addToLibrary = async (
  context: DispatchContext,
  binding: ResolvedBinding,
  manifest: MangaRequestManifest
): Promise<RequestDispatchOutcome | undefined> => {
  const { client, call } = context;
  const details = await client.getMangaDetails(binding.mangaId, call);
  if (!isSameManga(details, binding)) {
    return settle(context, MangaDispatchError.BINDING_MISSING, {
      countAttempt: true,
    });
  }
  await dataSource.transaction(async (manager) => {
    assertSameInstance(context.snapshot);
    await manager
      .createQueryBuilder()
      .insert()
      .into(MangaLibraryOwnership)
      .values({
        instanceId: binding.instanceId,
        sourceId: binding.sourceId,
        urlHash: binding.urlHash,
        url: binding.url,
        addedBySeerrng: !details.inLibrary,
      })
      .orIgnore()
      .execute();
  });
  if (!details.inLibrary) {
    await client.setInLibrary(binding.mangaId, true, call);
  }
  await advance(context, manifest);
  return undefined;
};

/**
 * Step 4: the category, then the request index, then the stamp. The index
 * goes first so the release can always find a manga whose stamp names the
 * request.
 */
const prepareCategory = async (
  context: DispatchContext,
  binding: ResolvedBinding,
  manifest: MangaRequestManifest
): Promise<RequestDispatchOutcome | undefined> => {
  const { client, call } = context;
  const category = await client.findOrCreateCategory(
    MANGA_DISPATCH_CATEGORY,
    call
  );
  await client.addMangaToCategory(binding.mangaId, category.id, call);
  await client.setRequestIndex(
    String(context.requestId),
    buildRequestIndexValue(binding),
    call
  );
  const details = await client.getMangaDetails(binding.mangaId, call);
  if (!isSameManga(details, binding)) {
    return settle(context, MangaDispatchError.BINDING_MISSING, {
      countAttempt: true,
    });
  }
  const stamp = await buildRequestStamp(binding, context.requestId);
  if (details.meta[REQUEST_STAMP_KEY] !== stamp) {
    await client.setRequestStamp(binding.mangaId, stamp, call);
  }
  await advance(context, manifest);
  return undefined;
};

/**
 * Asks the source for the chapter list. Data that came with errors counts
 * as a failed fetch; after MANGA_SOURCE_FETCH_ATTEMPTS failures in a row the
 * request moves to the slower schedule.
 */
const fetchSourceChapters = async (
  context: DispatchContext,
  binding: ResolvedBinding,
  manifest: MangaRequestManifest
): Promise<SuwayomiChapter[] | RequestDispatchOutcome> => {
  let result: SuwayomiFetchResult | undefined;
  try {
    result = await context.client.fetchMangaAndChapters(binding.mangaId, {
      fetchManga: false,
      signal: context.signal,
    });
  } catch (error) {
    if (!(error instanceof SuwayomiError) || error.code !== 'UPSTREAM_ERROR') {
      throw error;
    }
  }
  if (result?.fresh && result.chapters) {
    return result.chapters;
  }
  return manifest.attempts + 1 >= MANGA_SOURCE_FETCH_ATTEMPTS
    ? settle(context, MangaDispatchError.SOURCE_UNAVAILABLE, {
        waitMs: MANGA_DISPATCH_WAIT_MS.attention,
        countAttempt: true,
      })
    : settle(context, MangaDispatchError.SOURCE_FETCH_FAILED, {
        countAttempt: true,
      });
};

/** Step 5: fetches the chapter list from the source, never the manga. */
const fetchChapters = async (
  context: DispatchContext,
  binding: ResolvedBinding,
  manifest: MangaRequestManifest
): Promise<RequestDispatchOutcome | undefined> => {
  const chapters = await fetchSourceChapters(context, binding, manifest);
  if (!Array.isArray(chapters)) {
    return chapters;
  }
  context.chapters = chapters;
  await advance(context, manifest);
  return undefined;
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

/**
 * Step 6: selects the chapters, writes them and freezes the scope in one
 * transaction. Downloaded chapters count. A run that did not fetch the list
 * itself (after a restart or a wait) fetches it again first.
 */
const freezeManifest = async (
  context: DispatchContext,
  binding: ResolvedBinding,
  manifest: MangaRequestManifest
): Promise<RequestDispatchOutcome | undefined> => {
  if (manifest.frozenAt != null) {
    await advance(context, manifest);
    return undefined;
  }
  let chapters = context.chapters;
  if (!chapters) {
    const fetched = await fetchSourceChapters(context, binding, manifest);
    if (!Array.isArray(fetched)) {
      return fetched;
    }
    chapters = fetched;
    context.chapters = fetched;
  }
  const candidates = chapters.map(toChapterCandidate);
  let frozen: boolean;
  try {
    frozen = await dataSource.transaction(async (manager) => {
      const current = await manager.findOne(MangaRequestManifest, {
        where: { id: manifest.id },
      });
      if (
        !current ||
        current.bindingState !== MangaRequestBindingState.BOUND ||
        current.checkpoint !== MangaRequestCheckpoint.CHAPTERS_FETCHED ||
        current.frozenAt != null
      ) {
        throw new ManifestMovedError();
      }
      const rows = buildMangaRequestChapterRows(
        current.id,
        selectMangaManifestChapters(
          current,
          candidates,
          context.snapshot.scanlatorPreference ?? []
        )
      );
      if (rows.length === 0) {
        return false;
      }
      assertSameInstance(context.snapshot);
      for (const slice of chunk(rows, INSERT_SLICE)) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(MangaRequestChapter)
          .values(slice)
          .orIgnore()
          .execute();
      }
      if (!(await advanceIn(manager, current, true))) {
        throw new ManifestMovedError();
      }
      return true;
    });
  } catch (error) {
    if (error instanceof ManifestMovedError) {
      return undefined;
    }
    throw error;
  }
  return frozen
    ? undefined
    : settle(context, MangaDispatchError.NO_MATCHING_CHAPTERS, {
        waitMs: MANGA_DISPATCH_WAIT_MS.noMatchingChapters,
      });
};

/**
 * Step 7: maps the frozen chapters to current chapter IDs by URL and queues
 * the ones neither downloaded nor queued, recording each before it is
 * queued. Never starts the downloader.
 */
const enqueueChapters = async (
  context: DispatchContext,
  binding: ResolvedBinding,
  manifest: MangaRequestManifest
): Promise<RequestDispatchOutcome | undefined> => {
  const { client, call } = context;
  const frozen = await getRepository(MangaRequestChapter).find({
    select: { id: true, url: true, urlHash: true },
    where: { manifestId: manifest.id },
    order: { id: 'ASC' },
  });
  const waiting = await client.getChaptersToDownload(binding.mangaId, call);
  const downloaded = await client.getDownloadedChapters(binding.mangaId, call);
  const queue = await client.getQueue(call);

  const downloadedHashes = new Set(
    downloaded.map(({ url }) => hashMangaSourceUrl(url))
  );
  const chapterIds = new Map<string, string>();
  for (const chapter of waiting) {
    const urlHash = hashMangaSourceUrl(chapter.url);
    if (!chapterIds.has(urlHash)) {
      chapterIds.set(urlHash, chapter.id);
    }
  }
  const queued = new Set(queue.items.map(({ chapterId }) => chapterId));
  const pending: { row: MangaRequestChapter; chapterId: string }[] = [];
  let unmapped = 0;
  for (const row of frozen) {
    if (downloadedHashes.has(row.urlHash)) {
      continue;
    }
    const chapterId = chapterIds.get(row.urlHash);
    if (chapterId === undefined) {
      unmapped += 1;
    } else if (!queued.has(chapterId)) {
      pending.push({ row, chapterId });
    }
  }
  if (unmapped > 0) {
    logger.warn('Manga chapters Suwayomi no longer lists were skipped', {
      label: LABEL,
      requestId: context.requestId,
      code: 'MANGA_CHAPTERS_UNMAPPED',
      count: unmapped,
    });
  }

  for (const batch of chunk(pending, QUEUE_BATCH_SIZE)) {
    context.signal?.throwIfAborted();
    await dataSource.transaction(async (manager) => {
      assertSameInstance(context.snapshot);
      await manager
        .createQueryBuilder()
        .insert()
        .into(MangaChapterOwnership)
        .values(
          batch.map(({ row }) => ({
            instanceId: binding.instanceId,
            sourceId: binding.sourceId,
            mangaUrlHash: binding.urlHash,
            chapterUrlHash: row.urlHash,
            chapterUrl: row.url,
          }))
        )
        .orIgnore()
        .execute();
    });
    await client.enqueueChapters(
      batch.map(({ chapterId }) => chapterId),
      call
    );
  }

  try {
    await dataSource.transaction(async (manager) => {
      const media =
        context.mediaId !== undefined
          ? await manager.findOne(Media, { where: { id: context.mediaId } })
          : null;
      assertSameInstance(context.snapshot);
      if (media && STATUSES_BELOW_PROCESSING.has(media.status)) {
        media.status = MediaStatus.PROCESSING;
        await manager.getRepository(Media).save(media);
      }
      if (!(await advanceIn(manager, manifest))) {
        throw new ManifestMovedError();
      }
    });
  } catch (error) {
    if (error instanceof ManifestMovedError) {
      return undefined;
    }
    throw error;
  }
  return DELIVERED;
};

const runStep = (
  context: DispatchContext,
  binding: ResolvedBinding,
  manifest: MangaRequestManifest
): Promise<RequestDispatchOutcome | undefined> => {
  switch (manifest.checkpoint) {
    case null:
    case MangaRequestCheckpoint.BINDING_VERIFIED:
      // Steps 1 and 2 ran before the lock; this records them.
      return advance(context, manifest).then(() => undefined);
    case MangaRequestCheckpoint.INSTANCE_MARKED:
      return addToLibrary(context, binding, manifest);
    case MangaRequestCheckpoint.LIBRARY_ADDED:
      return prepareCategory(context, binding, manifest);
    case MangaRequestCheckpoint.CATEGORY_READY:
      return fetchChapters(context, binding, manifest);
    case MangaRequestCheckpoint.CHAPTERS_FETCHED:
      return freezeManifest(context, binding, manifest);
    case MangaRequestCheckpoint.MANIFEST_FROZEN:
      return enqueueChapters(context, binding, manifest);
    case MangaRequestCheckpoint.CHAPTERS_ENQUEUED:
      return Promise.resolve(DELIVERED);
    default:
      return settle(context, MangaDispatchError.DISPATCH_ERROR, {
        countAttempt: true,
      });
  }
};

/** Steps 3 to 7, under the manga's lock, each from a fresh manifest read. */
const runSteps = async (
  context: DispatchContext,
  binding: ResolvedBinding
): Promise<RequestDispatchOutcome> => {
  for (let step = 0; step < MAX_STEPS_PER_RUN; step += 1) {
    const manifest = await getRepository(MangaRequestManifest).findOne({
      where: { id: context.manifestId },
    });
    if (!manifest || manifest.bindingState !== MangaRequestBindingState.BOUND) {
      return DELIVERED;
    }
    if (
      manifest.bindingSourceId !== binding.sourceId ||
      manifest.bindingUrlHash !== binding.urlHash
    ) {
      return settle(context, MangaDispatchError.DISPATCH_ERROR, {
        countAttempt: true,
      });
    }
    const outcome = await runStep(context, binding, manifest);
    if (outcome) {
      return outcome;
    }
  }
  return settle(context, MangaDispatchError.DISPATCH_ERROR, {
    countAttempt: true,
  });
};

/**
 * Sends an approved manga request to Suwayomi, resuming after its last
 * completed step. Returns delivered once its chapters are queued, and
 * whenever the request should leave the outbox: it is no longer approved,
 * it was parked, or it waits longer than the outbox allows (the sweep picks
 * it up again once `retryNotBefore` passes). The request stays APPROVED.
 *
 * Takes no instance admission: each write transaction checks the instance
 * against the snapshot taken before its client was built.
 */
export const dispatchMangaRequest = async (
  request: MediaRequest,
  options: MangaDispatchOptions = {}
): Promise<RequestDispatchOutcome> => {
  const manifest = await getRepository(MangaRequestManifest).findOne({
    where: { requestId: request.id },
  });
  if (
    !manifest ||
    request.status !== MediaRequestStatus.APPROVED ||
    !isMediaCategoryEnabled('manga') ||
    manifest.bindingState !== MangaRequestBindingState.BOUND ||
    manifest.checkpoint === MangaRequestCheckpoint.CHAPTERS_ENQUEUED
  ) {
    return DELIVERED;
  }
  const target: DispatchTarget = {
    requestId: request.id,
    manifestId: manifest.id,
  };
  const snapshot = snapshotSuwayomiInstance(manifest.instanceId);
  let client: SuwayomiAPI | undefined;
  if (snapshot) {
    try {
      client = (options.clientFor ?? getSuwayomiClient)(manifest.instanceId);
    } catch (error) {
      if (!(error instanceof SuwayomiError)) {
        throw error;
      }
    }
  }
  if (!snapshot || !client) {
    return settle(target, MangaDispatchError.INSTANCE_MISSING, {
      waitMs: MANGA_DISPATCH_WAIT_MS.attention,
    });
  }
  const mediaId = request.media?.id;
  const context: DispatchContext = {
    ...target,
    mediaId: Number.isSafeInteger(mediaId) ? mediaId : undefined,
    instanceId: manifest.instanceId,
    snapshot,
    client,
    call: { signal: options.signal },
    signal: options.signal,
  };
  try {
    const binding = await resolveBinding(context, manifest);
    if ('delivered' in binding) {
      return binding;
    }
    const mismatch = await verifyInstanceMarker(context);
    if (mismatch) {
      return mismatch;
    }
    if (binding.previousMangaId !== undefined) {
      // Best effort: the manifest no longer names that manga, so a failed
      // rewrite is not tried again.
      await refreshRequestStamp(
        context.client,
        context.instanceId,
        binding.previousMangaId,
        context.call
      ).catch((error: unknown) => {
        if (isAbortError(error)) {
          throw error;
        }
        logger.debug('Manga dispatch left a stale request stamp', {
          label: LABEL,
          requestId: request.id,
          ...errorDetails(error),
        });
      });
    }
    return await runWithMangaDispatchLock(
      binding.instanceId,
      binding.sourceId,
      binding.urlHash,
      () => runSteps(context, binding)
    );
  } catch (error) {
    return settleError(target, error);
  }
};

/**
 * Approved manga requests the sweep should queue: BOUND, not yet enqueued,
 * past any wait, and without an outbox row. Oldest first.
 */
export const findDueMangaRequestIds = async (
  limit: number
): Promise<number[]> => {
  const rows = await getRepository(MediaRequest)
    .createQueryBuilder('mediaRequest')
    .innerJoin(
      MangaRequestManifest,
      'manifest',
      'manifest.requestId = mediaRequest.id'
    )
    .select('mediaRequest.id', 'id')
    .where('mediaRequest.type = :type', { type: MediaType.MANGA })
    .andWhere('mediaRequest.status = :status', {
      status: MediaRequestStatus.APPROVED,
    })
    .andWhere('manifest.bindingState = :bound', {
      bound: MangaRequestBindingState.BOUND,
    })
    .andWhere('(manifest.checkpoint IS NULL OR manifest.checkpoint != :done)', {
      done: MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
    })
    .andWhere(
      '(manifest.retryNotBefore IS NULL OR manifest.retryNotBefore <= :now)',
      { now: new Date() }
    )
    .andWhere((query) => {
      const queued = query
        .subQuery()
        .select('1')
        .from(RequestDispatchOutbox, 'dispatch')
        .where('dispatch.requestId = mediaRequest.id')
        .getQuery();
      return `NOT EXISTS ${queued}`;
    })
    .orderBy('mediaRequest.updatedAt', 'ASC')
    .addOrderBy('mediaRequest.id', 'ASC')
    .limit(limit)
    .getRawMany<{ id: number | string }>();
  return rows.map(({ id }) => Number(id));
};

export interface MangaReleaseOptions {
  signal?: AbortSignal;
  /** Replaces the shared client factory; tests pass their own client. */
  clientFor?: (instanceId: number) => SuwayomiAPI | undefined;
}

/**
 * Chapter ownership rows that no approved request's frozen chapters still
 * reference on the same instance and manga.
 */
const releasableChapters = (manager: EntityManager) =>
  manager
    .getRepository(MangaChapterOwnership)
    .createQueryBuilder('owned')
    .where((builder) => {
      const referenced = builder
        .subQuery()
        .select('1')
        .from(MangaRequestChapter, 'chapter')
        .innerJoin(
          MangaRequestManifest,
          'manifest',
          'manifest.id = chapter.manifestId'
        )
        .innerJoin(MediaRequest, 'request', 'request.id = manifest.requestId')
        .where('request.status = :approved')
        .andWhere('manifest.instanceId = owned.instanceId')
        .andWhere('manifest.bindingSourceId = owned.sourceId')
        .andWhere('manifest.bindingUrlHash = owned.mangaUrlHash')
        .andWhere('chapter.urlHash = owned.chapterUrlHash')
        .getQuery();
      return `NOT EXISTS ${referenced}`;
    })
    .setParameter('approved', MediaRequestStatus.APPROVED);

/** The first releasable rows of an instance, or of one manga on it. */
const findReleasableChapters = (
  manager: EntityManager,
  {
    instanceId,
    sourceId,
    urlHash,
  }: { instanceId: number; sourceId?: string; urlHash?: string }
): Promise<MangaChapterOwnership[]> => {
  const query = releasableChapters(manager).andWhere(
    'owned.instanceId = :instanceId',
    { instanceId }
  );
  if (sourceId !== undefined && urlHash !== undefined) {
    query
      .andWhere('owned.sourceId = :sourceId', { sourceId })
      .andWhere('owned.mangaUrlHash = :urlHash', { urlHash });
  }
  return query.orderBy('owned.id', 'ASC').limit(RELEASE_SCAN_LIMIT).getMany();
};

/**
 * Instances with releasable rows. Each is scanned on its own, so rows that
 * wait on one server never hold up another's.
 */
const findReleasableInstanceIds = async (): Promise<number[]> =>
  (
    await releasableChapters(dataSource.manager)
      .select('owned.instanceId', 'instanceId')
      .distinct(true)
      .orderBy('owned.instanceId', 'ASC')
      .getRawMany<{ instanceId: number | string }>()
  ).map(({ instanceId }) => Number(instanceId));

/** Deletes released rows that are still unreferenced. */
const deleteReleasedChapters = (
  key: MangaKey,
  rows: readonly MangaChapterOwnership[],
  snapshot?: SuwayomiSettings
): Promise<void> =>
  dataSource.transaction(async (manager) => {
    const releasable = new Set(
      (await findReleasableChapters(manager, key)).map(({ id }) => id)
    );
    const ids = rows.map(({ id }) => id).filter((id) => releasable.has(id));
    if (snapshot) {
      assertSameInstance(snapshot);
    }
    if (ids.length > 0) {
      await manager.delete(MangaChapterOwnership, { id: In(ids) });
    }
  });

const hasOwnMarker = async (
  client: SuwayomiAPI,
  instanceId: number,
  call: SuwayomiCallOptions
): Promise<boolean> => {
  const own = await getRepository(MangaInstanceMarker).findOne({
    where: { instanceId },
  });
  return own !== null && (await client.getInstanceMarker(call)) === own.marker;
};

/** A trusted instance's client, with the settings it was built from. */
interface ReleaseTarget {
  snapshot: SuwayomiSettings;
  client: SuwayomiAPI;
  call: SuwayomiCallOptions;
}

/**
 * Dequeues one manga's released chapters that are still queued, then drops
 * their ownership rows. Without a target the instance is gone, and the rows
 * go without a call; they also go when Suwayomi no longer has the manga.
 */
const releaseMangaChapters = async (
  key: MangaKey,
  target: ReleaseTarget | undefined,
  signal: AbortSignal | undefined
): Promise<void> => {
  const rows = await findReleasableChapters(dataSource.manager, key);
  if (rows.length === 0) {
    return;
  }
  if (!target) {
    await deleteReleasedChapters(key, rows);
    return;
  }
  const { snapshot, client, call } = target;
  const library = await getRepository(MangaLibraryOwnership).findOne({
    where: {
      instanceId: key.instanceId,
      sourceId: key.sourceId,
      urlHash: key.urlHash,
    },
  });
  if (!library) {
    logger.warn('Released manga chapters had no library record', {
      label: LABEL,
      instanceId: key.instanceId,
      code: 'MANGA_RELEASE_UNRESOLVED',
      count: rows.length,
    });
    await deleteReleasedChapters(key, rows, snapshot);
    return;
  }
  const manga = await client.findMangaByNaturalKey(
    key.sourceId,
    library.url,
    call
  );
  if (manga) {
    const waiting = new Map<string, string>();
    for (const chapter of await client.getChaptersToDownload(manga.id, call)) {
      const urlHash = hashMangaSourceUrl(chapter.url);
      if (!waiting.has(urlHash)) {
        waiting.set(urlHash, chapter.id);
      }
    }
    const queued = new Set(
      (await client.getQueue(call)).items.map(({ chapterId }) => chapterId)
    );
    const ids = [
      ...new Set(
        rows.flatMap(({ chapterUrlHash }) => {
          const chapterId = waiting.get(chapterUrlHash);
          return chapterId !== undefined && queued.has(chapterId)
            ? [chapterId]
            : [];
        })
      ),
    ];
    for (const batch of chunk(ids, QUEUE_BATCH_SIZE)) {
      signal?.throwIfAborted();
      await client.dequeueChapters(batch, call);
    }
  }
  await deleteReleasedChapters(key, rows, snapshot);
};

/** Logs a failure that the next sweep retries; an abort propagates. */
const logReleaseFailure = (
  error: unknown,
  instanceId: number,
  signal: AbortSignal | undefined
): void => {
  signal?.throwIfAborted();
  logger.warn('Manga dispatch release will retry', {
    label: LABEL,
    instanceId,
    ...errorDetails(error),
  });
};

/**
 * Releases one instance's chapters, reading its marker once per run. While
 * the server carries another marker or none, its rows wait.
 */
const releaseInstanceChapters = async (
  instanceId: number,
  options: MangaReleaseOptions
): Promise<void> => {
  const keys = new Map<string, MangaKey>();
  for (const row of await findReleasableChapters(dataSource.manager, {
    instanceId,
  })) {
    keys.set(`${row.sourceId}:${row.mangaUrlHash}`, {
      instanceId,
      sourceId: row.sourceId,
      urlHash: row.mangaUrlHash,
    });
  }
  if (keys.size === 0) {
    return;
  }
  const snapshot = snapshotSuwayomiInstance(instanceId);
  let target: ReleaseTarget | undefined;
  if (snapshot) {
    const client = (options.clientFor ?? getSuwayomiClient)(instanceId);
    const call: SuwayomiCallOptions = { signal: options.signal };
    if (!client || !(await hasOwnMarker(client, instanceId, call))) {
      return;
    }
    target = { snapshot, client, call };
  }
  for (const key of keys.values()) {
    options.signal?.throwIfAborted();
    try {
      await runWithMangaDispatchLock(
        instanceId,
        key.sourceId,
        key.urlHash,
        () => releaseMangaChapters(key, target, options.signal)
      );
    } catch (error) {
      if (error instanceof SuwayomiInstanceChangedError) {
        throw error;
      }
      logReleaseFailure(error, instanceId, options.signal);
    }
  }
};

const releaseChapters = async (options: MangaReleaseOptions): Promise<void> => {
  for (const instanceId of await findReleasableInstanceIds()) {
    options.signal?.throwIfAborted();
    try {
      await releaseInstanceChapters(instanceId, options);
    } catch (error) {
      logReleaseFailure(error, instanceId, options.signal);
    }
  }
};

/** A positive Suwayomi manga ID from an index value, else undefined. */
const parseIndexedMangaId = (value: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const mangaId = isRecord(parsed) ? parsed.mangaId : undefined;
  return typeof mangaId === 'number' &&
    Number.isSafeInteger(mangaId) &&
    mangaId > 0 &&
    mangaId <= MAX_SUWAYOMI_INT
    ? String(mangaId)
    : undefined;
};

/** Index entries whose request is approved and targets this instance. */
const findLiveIndexedRequestIds = async (
  instanceId: number,
  requestIds: readonly number[]
): Promise<Set<number>> => {
  const live = new Set<number>();
  const candidates = [...new Set(requestIds)].filter(
    (id) => Number.isSafeInteger(id) && id > 0 && id <= MAX_SUWAYOMI_INT
  );
  for (const slice of chunk(candidates, ID_SLICE)) {
    const rows = await getRepository(MangaRequestManifest)
      .createQueryBuilder('manifest')
      .innerJoin(MediaRequest, 'request', 'request.id = manifest.requestId')
      .select('manifest.requestId', 'requestId')
      .where('manifest.requestId IN (:...requestIds)', { requestIds: slice })
      .andWhere('manifest.instanceId = :instanceId', { instanceId })
      .andWhere('request.type = :type', { type: MediaType.MANGA })
      .andWhere('request.status = :status', {
        status: MediaRequestStatus.APPROVED,
      })
      .getRawMany<{ requestId: number | string }>();
    for (const { requestId } of rows) {
      live.add(Number(requestId));
    }
  }
  return live;
};

/**
 * Rewrites one manga's stamp from the database, then runs `afterwards` under
 * the same lock. The index value only chose the manga; the server's details
 * decide which manga it is.
 */
const refreshRequestStamp = async (
  client: SuwayomiAPI,
  instanceId: number,
  mangaId: string,
  call: SuwayomiCallOptions,
  afterwards: () => Promise<void> = async () => undefined
): Promise<void> => {
  let details: SuwayomiMangaDetails;
  try {
    details = await client.getMangaDetails(mangaId, call);
  } catch (error) {
    if (error instanceof SuwayomiError && error.code === 'NOT_FOUND') {
      return afterwards();
    }
    throw error;
  }
  const key: MangaKey = {
    instanceId,
    sourceId: details.sourceId,
    urlHash: hashMangaSourceUrl(details.url),
  };
  await runWithMangaDispatchLock(
    key.instanceId,
    key.sourceId,
    key.urlHash,
    async () => {
      const current = await client.getMangaDetails(mangaId, call);
      const written = current.meta[REQUEST_STAMP_KEY];
      if (isSameManga(current, key) && written !== undefined) {
        const stamp = await buildRequestStamp(key);
        if (written !== stamp) {
          await client.setRequestStamp(mangaId, stamp, call);
        }
      }
      await afterwards();
    }
  );
};

/** Drops index entries whose request is no longer approved on the instance. */
const releaseInstanceMirrors = async (
  instanceId: number,
  options: MangaReleaseOptions
): Promise<void> => {
  const client = (options.clientFor ?? getSuwayomiClient)(instanceId);
  const call: SuwayomiCallOptions = { signal: options.signal };
  if (!client || !(await hasOwnMarker(client, instanceId, call))) {
    return;
  }
  const entries = await client.listRequestIndex(call);
  const live = await findLiveIndexedRequestIds(
    instanceId,
    entries.map(({ requestId }) => Number(requestId))
  );
  const stale = entries
    .filter(({ requestId }) => !live.has(Number(requestId)))
    .slice(0, MIRROR_RELEASE_LIMIT);
  for (const entry of stale) {
    options.signal?.throwIfAborted();
    const requestId = Number(entry.requestId);
    // Checked again under the manga's lock, so a request approved again
    // since the list was read keeps the entry its dispatch writes.
    const drop = async () => {
      const revived = await findLiveIndexedRequestIds(instanceId, [requestId]);
      if (!revived.has(requestId)) {
        await client.deleteRequestIndex(entry.requestId, call);
      }
    };
    const mangaId = parseIndexedMangaId(entry.value);
    await (mangaId === undefined
      ? drop()
      : refreshRequestStamp(client, instanceId, mangaId, call, drop));
  }
};

const releaseMirrors = async (options: MangaReleaseOptions): Promise<void> => {
  const marked = new Set(
    (
      await getRepository(MangaInstanceMarker).find({
        select: { id: true, instanceId: true },
      })
    ).map(({ instanceId }) => instanceId)
  );
  for (const { id: instanceId } of getExternalRuntimeConfig().suwayomi) {
    if (!marked.has(instanceId)) {
      continue;
    }
    options.signal?.throwIfAborted();
    try {
      await releaseInstanceMirrors(instanceId, options);
    } catch (error) {
      logReleaseFailure(error, instanceId, options.signal);
    }
  }
};

/**
 * Hands back what requests no longer need. Dequeues chapters SeerrNG queued
 * that no approved request references any more, then drops request-index
 * entries whose request is no longer approved and rewrites the stamp of
 * their manga from the database. Never deletes files, library entries or
 * the category. Failures are logged per manga or instance and retried by
 * the next sweep.
 */
export const releaseMangaDispatch = async (
  options: MangaReleaseOptions = {}
): Promise<void> => {
  await releaseChapters(options);
  await releaseMirrors(options);
};

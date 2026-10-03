import {
  SuwayomiError,
  type SuwayomiErrorCode,
} from '@server/api/suwayomi/errors';
import { MediaStatus } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaMatchCandidate from '@server/entity/MangaMatchCandidate';
import MangaSourceBinding, {
  MANGA_BINDING_ORIGIN_ADMIN,
  MANGA_MATCHED_BY_MANUAL,
  MANGA_MATCHED_BY_TITLE,
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import { runWithRequestAdmission } from '@server/entity/MediaRequest';
import type {
  MangaLibraryBinding,
  MangaLibraryBindingsResponse,
  MangaLibraryCandidate,
  MangaLibraryCandidatesResponse,
  MangaLibraryErrorCode,
  MangaLibraryItemState,
  MangaLibraryProposal,
} from '@server/interfaces/api/mangaLibraryInterfaces';
import {
  computeMangaAvailability,
  needsMangaChapterStates,
} from '@server/lib/mangaAvailability';
import {
  getMangaAdmissionKey,
  newMangaMediaTally,
  reconcileMangaMedia,
} from '@server/lib/mangaMedia';
import { syncMangaRequestBindings } from '@server/lib/mangaRequestBindings';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import {
  SuwayomiInstanceChangedError,
  runWithSuwayomiInstanceAdmission,
  snapshotSuwayomiInstance,
} from '@server/lib/suwayomi/instanceAdmission';
import logger from '@server/logger';
import { isUniqueConstraintError } from '@server/utils/databaseError';
import { IsNull, type EntityManager } from 'typeorm';

const LABEL = 'Manga Library';
const MAX_INT32 = 2_147_483_647;

const ERRORS: Record<MangaLibraryErrorCode, [status: number, message: string]> =
  {
    MANGA_INVALID_REQUEST: [400, 'The request is invalid.'],
    MANGA_INSTANCE_NOT_FOUND: [404, 'The Suwayomi instance was not found.'],
    MANGA_CANDIDATE_NOT_FOUND: [404, 'The match candidate was not found.'],
    MANGA_ITEM_NOT_FOUND: [404, 'The library item was not found.'],
    MANGA_PROPOSAL_CHANGED: [409, 'The proposal has changed.'],
    MANGA_NOT_IN_LIBRARY: [409, 'The manga is not in the Suwayomi library.'],
    MANGA_UNSUPPORTED_SERVER: [409, 'This Suwayomi server is not supported.'],
    MANGA_INSTANCE_CHANGED: [409, 'The Suwayomi instance has changed.'],
    MANGA_ITEM_CHANGED: [409, 'The library item has changed.'],
    MANGA_UNIQUE_CONFLICT: [409, 'A concurrent change to the item won.'],
    MANGA_SUWAYOMI_LOOKUP_FAILED: [502, 'The Suwayomi lookup failed.'],
  };

/** A review failure with a stable code and a fixed message. */
export class MangaLibraryError extends Error {
  constructor(
    readonly code: MangaLibraryErrorCode,
    readonly suwayomiCode?: SuwayomiErrorCode
  ) {
    super(ERRORS[code][1]);
    this.name = 'MangaLibraryError';
  }

  get status(): number {
    return ERRORS[this.code][0];
  }
}

const PROPOSAL_CONFIDENCES: ReadonlySet<MangaBindingConfidence> = new Set([
  MangaBindingConfidence.HIGH,
  MangaBindingConfidence.MEDIUM,
  MangaBindingConfidence.LOW,
]);

const isProposalConfidence = (
  value: MangaBindingConfidence | null
): value is MangaLibraryProposal['confidence'] =>
  value !== null && PROPOSAL_CONFIDENCES.has(value);

const iso = (value: Date | string) => new Date(value).toISOString();

const candidateView = (row: MangaMatchCandidate): MangaLibraryCandidate => ({
  id: row.id,
  instanceId: row.instanceId,
  suwayomiMangaId: row.suwayomiMangaId,
  sourceId: row.sourceId,
  url: row.url,
  title: row.title,
  proposal:
    row.proposedAnilistId !== null &&
    isProposalConfidence(row.proposalConfidence)
      ? {
          anilistId: row.proposedAnilistId,
          confidence: row.proposalConfidence,
          score: (row.proposalScore ?? 0) / 1000,
        }
      : null,
  updatedAt: iso(row.updatedAt),
});

const bindingView = (row: MangaSourceBinding): MangaLibraryBinding => ({
  id: row.id,
  instanceId: row.instanceId,
  sourceId: row.sourceId,
  url: row.url,
  suwayomiMangaId: row.suwayomiMangaId,
  title: row.title,
  anilistId: row.anilistId,
  confidence: row.confidence,
  matchedBy: row.matchedBy,
  origin: row.origin,
  state: row.state,
  inLibrary: row.inLibrary,
  availability: row.availability,
  chapterCount: row.chapterCount,
  downloadCount: row.downloadCount,
  updatedAt: iso(row.updatedAt),
});

const pageInfo = (take: number, skip: number, results: number) => ({
  page: Math.ceil(skip / take) + 1,
  pages: Math.ceil(results / take),
  pageSize: take,
  results,
});

export const listMangaCandidates = async ({
  take,
  skip,
  instanceId,
  confidence,
}: {
  take: number;
  skip: number;
  instanceId?: number;
  confidence?: MangaLibraryProposal['confidence'] | 'NONE';
}): Promise<MangaLibraryCandidatesResponse> => {
  // TypeORM rejects undefined filter values, so only set ones are added.
  const [rows, count] = await getRepository(MangaMatchCandidate).findAndCount({
    where: {
      ...(instanceId !== undefined && { instanceId }),
      ...(confidence === 'NONE' && { proposedAnilistId: IsNull() }),
      ...(confidence &&
        confidence !== 'NONE' && { proposalConfidence: confidence }),
    },
    order: { id: 'ASC' },
    take,
    skip,
  });
  return {
    pageInfo: pageInfo(take, skip, count),
    results: rows.map(candidateView),
  };
};

export const listMangaBindings = async ({
  take,
  skip,
  instanceId,
  anilistId,
  state,
}: {
  take: number;
  skip: number;
  instanceId?: number;
  anilistId?: number;
  state?: MangaBindingState;
}): Promise<MangaLibraryBindingsResponse> => {
  const [rows, count] = await getRepository(MangaSourceBinding).findAndCount({
    where: {
      ...(instanceId !== undefined && { instanceId }),
      ...(anilistId !== undefined && { anilistId }),
      ...(state && { state }),
    },
    order: { id: 'ASC' },
    take,
    skip,
  });
  return {
    pageInfo: pageInfo(take, skip, count),
    results: rows.map(bindingView),
  };
};

interface ItemKey {
  instanceId: number;
  sourceId: string;
  url: string;
}

/** One source manga's rows, by its natural key. */
const loadItem = async (
  manager: EntityManager,
  { instanceId, sourceId, url }: ItemKey
) => {
  const where = { instanceId, sourceId, urlHash: hashMangaSourceUrl(url) };
  const bindings = await manager.find(MangaSourceBinding, {
    where,
    order: { id: 'ASC' },
  });
  const candidate = await manager.findOneBy(MangaMatchCandidate, where);
  return {
    bindings: bindings.filter((row) => row.url === url),
    candidate: candidate?.url === url ? candidate : undefined,
  };
};

const liveOf = (rows: readonly MangaSourceBinding[]) =>
  rows.find((row) => row.state !== MangaBindingState.REJECTED);

const loadItemState = async (key: ItemKey): Promise<MangaLibraryItemState> => {
  const { bindings, candidate } = await loadItem(dataSource.manager, key);
  const live = liveOf(bindings);
  return {
    binding: live ? bindingView(live) : null,
    candidate: candidate ? candidateView(candidate) : null,
  };
};

export const findMangaLibraryCandidate = async (
  id: number
): Promise<MangaMatchCandidate> => {
  const candidate = await getRepository(MangaMatchCandidate).findOneBy({ id });
  if (!candidate) throw new MangaLibraryError('MANGA_CANDIDATE_NOT_FOUND');
  return candidate;
};

const findInstance = (instanceId: number): SuwayomiSettings => {
  const snapshot = snapshotSuwayomiInstance(instanceId);
  if (!snapshot) throw new MangaLibraryError('MANGA_INSTANCE_NOT_FOUND');
  return snapshot;
};

export type MangaLibraryLookup =
  { suwayomiMangaId: number } | { sourceId: string; url: string };

/** What the read-only Suwayomi lookups found for one library item. */
export interface MangaLibraryRead extends ItemKey {
  snapshot: SuwayomiSettings;
  suwayomiMangaId: number;
  title: string;
  /** Left out when the counts contradict each other, so the stored ones stay. */
  counts?: Pick<
    MangaSourceBinding,
    'chapterCount' | 'downloadCount' | 'availability'
  >;
  /** The AniList ID of the item's live binding, when one existed. */
  liveAnilistId?: number;
}

/**
 * Reads the item from Suwayomi, before any admission or transaction. Every
 * Suwayomi failure is a 502 that writes nothing.
 */
export const readMangaLibraryItem = async (
  instanceId: number,
  lookup: MangaLibraryLookup,
  signal: AbortSignal
): Promise<MangaLibraryRead> => {
  const snapshot = findInstance(instanceId);
  try {
    const client = getSuwayomiClient(instanceId);
    if (!client) throw new MangaLibraryError('MANGA_INSTANCE_NOT_FOUND');
    const capabilities = await client.getCapabilities({ signal });
    if (!capabilities.supported || capabilities.perUserDownloadState) {
      throw new MangaLibraryError('MANGA_UNSUPPORTED_SERVER');
    }
    const details =
      'suwayomiMangaId' in lookup
        ? await client
            .getMangaDetails(String(lookup.suwayomiMangaId), { signal })
            .catch((error: unknown) => {
              if (error instanceof SuwayomiError && error.code === 'NOT_FOUND')
                return undefined;
              throw error;
            })
        : await client.findMangaByNaturalKey(lookup.sourceId, lookup.url, {
            signal,
          });
    if (!details) throw new MangaLibraryError('MANGA_ITEM_NOT_FOUND');
    if (!details.inLibrary) throw new MangaLibraryError('MANGA_NOT_IN_LIBRARY');
    const suwayomiMangaId = Number(details.id);
    if (suwayomiMangaId > MAX_INT32) {
      throw new SuwayomiError('BAD_RESPONSE', 'MangaDetails');
    }
    let chapterStates;
    if (needsMangaChapterStates(details)) {
      const [states] = await client.getLibraryChapterStates([details.id], {
        signal,
      });
      // Only a complete list of this manga's chapters can settle it.
      if (
        states?.mangaId === details.id &&
        states.chapters.length === states.totalCount
      ) {
        chapterStates = states.chapters;
      }
    }
    const availability = computeMangaAvailability({
      ...details,
      chapterStates,
    });
    const key = { instanceId, sourceId: details.sourceId, url: details.url };
    const { bindings } = await loadItem(dataSource.manager, key);
    return {
      ...key,
      snapshot,
      suwayomiMangaId,
      // Details titles are cut at 512 UTF-16 units, which can split a pair.
      title: details.title.replace(/[\uD800-\uDBFF]$/, '').trim(),
      counts:
        availability === 'unreadable'
          ? undefined
          : {
              chapterCount: details.chapterCount,
              downloadCount: details.downloadCount,
              availability:
                availability === 'none' ? MediaStatus.UNKNOWN : availability,
            },
      liveAnilistId: liveOf(bindings)?.anilistId,
    };
  } catch (error) {
    if (!(error instanceof SuwayomiError)) throw error;
    throw new MangaLibraryError('MANGA_SUWAYOMI_LOOKUP_FAILED', error.code);
  }
};

/** Media follows the decision; only the decision's instance counts as read. */
const reconcileAfter = async (instanceId: number, anilistIds: number[]) => {
  const tally = newMangaMediaTally();
  try {
    await reconcileMangaMedia(anilistIds, {
      completedInstanceIds: new Set([instanceId]),
      tally,
      admitted: true,
    });
  } catch (error) {
    logger.warn('Manga media reconcile failed after a review decision', {
      label: LABEL,
      instanceId,
      code: error instanceof Error ? error.name : 'UNKNOWN',
    });
  }
  const { uniqueConflicts, identityConflicts } = tally;
  if (uniqueConflicts + identityConflicts > 0) {
    logger.warn('Manga media reconcile skipped titles after a review', {
      label: LABEL,
      instanceId,
      uniqueConflicts,
      identityConflicts,
    });
  }
};

/**
 * Requests on the decided titles follow the decision, including a link whose
 * chapter counts were unreadable and so was not reconciled.
 */
const syncRequestsAfter = async (anilistIds: number[]) => {
  try {
    await syncMangaRequestBindings(dataSource.manager, anilistIds);
  } catch (error) {
    logger.warn('Manga request binding sync failed after a review', {
      label: LABEL,
      code: error instanceof Error ? error.name : 'UNKNOWN',
    });
  }
};

const translateWriteError = (error: unknown): never => {
  if (error instanceof SuwayomiInstanceChangedError) {
    throw new MangaLibraryError('MANGA_INSTANCE_CHANGED');
  }
  if (isUniqueConstraintError(error)) {
    throw new MangaLibraryError('MANGA_UNIQUE_CONFLICT');
  }
  throw error;
};

/**
 * Binds the item to `anilistId`: a confirmed title proposal when
 * `candidateId` is given, a manual bind otherwise. A different live binding
 * is rejected. Runs under the titles' request admission and the instance's
 * admission, each taken once; the rows are re-read inside the transaction.
 */
export const linkMangaLibraryItem = (
  read: MangaLibraryRead,
  { anilistId, candidateId }: { anilistId: number; candidateId?: number }
): Promise<MangaLibraryItemState> => {
  const { snapshot, instanceId, sourceId, url } = read;
  const admitted = new Set([anilistId]);
  if (read.liveAnilistId !== undefined) admitted.add(read.liveAnilistId);
  const keys = [...admitted].sort((a, b) => a - b).map(getMangaAdmissionKey);
  return runWithRequestAdmission(keys, () =>
    runWithSuwayomiInstanceAdmission(snapshot, async () => {
      const demoted = await dataSource.transaction(async (manager) => {
        const { bindings, candidate } = await loadItem(manager, read);
        let link = {
          confidence: MangaBindingConfidence.MANUAL,
          matchedBy: MANGA_MATCHED_BY_MANUAL,
        };
        if (candidateId !== undefined) {
          if (candidate?.id !== candidateId) {
            throw new MangaLibraryError('MANGA_CANDIDATE_NOT_FOUND');
          }
          if (
            candidate.proposedAnilistId !== anilistId ||
            !candidate.proposalConfidence
          ) {
            throw new MangaLibraryError('MANGA_PROPOSAL_CHANGED');
          }
          link = {
            confidence: candidate.proposalConfidence,
            matchedBy: MANGA_MATCHED_BY_TITLE,
          };
        }
        const live = liveOf(bindings);
        // A title outside the admitted keys would be written unlocked.
        if (live && !admitted.has(live.anilistId)) {
          throw new MangaLibraryError('MANGA_ITEM_CHANGED');
        }
        // First, since at most one live binding may exist per item.
        if (live && live.anilistId !== anilistId) {
          await manager.update(MangaSourceBinding, live.id, {
            state: MangaBindingState.REJECTED,
            inLibrary: false,
          });
        }
        const values: Partial<MangaSourceBinding> = {
          ...link,
          origin: MANGA_BINDING_ORIGIN_ADMIN,
          state: MangaBindingState.ACTIVE,
          inLibrary: true,
          suwayomiMangaId: read.suwayomiMangaId,
          title: read.title,
          ...read.counts,
        };
        const pair = bindings.find((row) => row.anilistId === anilistId);
        if (pair) {
          await manager.update(MangaSourceBinding, pair.id, values);
        } else {
          await manager.insert(MangaSourceBinding, {
            instanceId,
            sourceId,
            url,
            urlHash: hashMangaSourceUrl(url),
            anilistId,
            chapterCount: null,
            downloadCount: null,
            availability: MediaStatus.UNKNOWN,
            ...values,
          });
        }
        if (candidate) await manager.delete(MangaMatchCandidate, candidate.id);
        return live && live.anilistId !== anilistId
          ? live.anilistId
          : undefined;
      });
      logger.info('Manga library item bound by an admin', {
        label: LABEL,
        instanceId,
        anilistId,
        rejectedAnilistId: demoted,
      });
      await reconcileAfter(instanceId, [
        ...(read.counts ? [anilistId] : []),
        ...(demoted === undefined ? [] : [demoted]),
      ]);
      await syncRequestsAfter(
        demoted === undefined ? [anilistId] : [anilistId, demoted]
      );
      return loadItemState(read);
    })
  ).catch(translateWriteError);
};

/**
 * Refuses the (item, AniList ID) pair for good: no step proposes or links it
 * again, though a manual bind still can. Touches only the database.
 */
export const rejectMangaLibraryPair = async (
  key: ItemKey,
  anilistId: number
): Promise<MangaLibraryItemState> => {
  const snapshot = findInstance(key.instanceId);
  const { instanceId, sourceId, url } = key;
  return runWithRequestAdmission([getMangaAdmissionKey(anilistId)], () =>
    runWithSuwayomiInstanceAdmission(snapshot, async () => {
      await dataSource.transaction(async (manager) => {
        const { bindings, candidate } = await loadItem(manager, key);
        if (bindings.length === 0 && !candidate) {
          throw new MangaLibraryError('MANGA_ITEM_NOT_FOUND');
        }
        const urlHash = hashMangaSourceUrl(url);
        const pair = bindings.find((row) => row.anilistId === anilistId);
        if (!pair) {
          const known = candidate ?? liveOf(bindings);
          await manager.insert(MangaSourceBinding, {
            instanceId,
            sourceId,
            url,
            urlHash,
            anilistId,
            suwayomiMangaId: known?.suwayomiMangaId ?? null,
            title: known?.title ?? null,
            confidence: MangaBindingConfidence.MANUAL,
            matchedBy: MANGA_MATCHED_BY_MANUAL,
            origin: MANGA_BINDING_ORIGIN_ADMIN,
            state: MangaBindingState.REJECTED,
            inLibrary: false,
            availability: MediaStatus.UNKNOWN,
            chapterCount: null,
            downloadCount: null,
          });
        } else if (pair.state !== MangaBindingState.REJECTED) {
          await manager.update(MangaSourceBinding, pair.id, {
            state: MangaBindingState.REJECTED,
            inLibrary: false,
          });
          // The item stays in the library, so it waits for review again.
          if (
            pair.state === MangaBindingState.ACTIVE &&
            pair.inLibrary &&
            !candidate &&
            pair.suwayomiMangaId !== null &&
            pair.title !== null
          ) {
            await manager.insert(MangaMatchCandidate, {
              instanceId,
              sourceId,
              url,
              urlHash,
              suwayomiMangaId: pair.suwayomiMangaId,
              title: pair.title,
            });
          }
        }
        // The next scan then proposes the best pair that isn't rejected.
        if (candidate?.proposedAnilistId === anilistId) {
          await manager.update(MangaMatchCandidate, candidate.id, {
            proposedAnilistId: null,
            proposalConfidence: null,
            proposalScore: null,
            titleCheckedAt: null,
          });
        }
      });
      logger.info('Manga library pair rejected by an admin', {
        label: LABEL,
        instanceId,
        anilistId,
      });
      await reconcileAfter(instanceId, [anilistId]);
      await syncRequestsAfter([anilistId]);
      return loadItemState(key);
    })
  ).catch(translateWriteError);
};

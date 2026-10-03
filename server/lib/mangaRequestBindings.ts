import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
} from '@server/entity/MangaSourceBinding';
import logger from '@server/logger';
import { chunk } from '@server/utils/chunk';
import type { EntityManager, QueryRunner } from 'typeorm';

/** The most AniList or request IDs one statement carries. */
const SYNC_SLICE = 500;

/** Whether the title has an ACTIVE source binding on the instance. */
export const hasActiveMangaBinding = (
  manager: EntityManager,
  anilistId: number,
  instanceId: number
): Promise<boolean> =>
  manager.exists(MangaSourceBinding, {
    where: { anilistId, instanceId, state: MangaBindingState.ACTIVE },
  });

const ACTIVE_BINDING_EXISTS = `EXISTS (SELECT 1 FROM "manga_source_binding" "binding" WHERE "binding"."anilistId" = "manga_request_manifest"."anilistId" AND "binding"."instanceId" = "manga_request_manifest"."instanceId" AND "binding"."state" = :active)`;

/** Binds parked manifests one by one, so each move is known. */
const bindSlice = async (
  manager: EntityManager,
  anilistIds: number[] | undefined
): Promise<number[]> => {
  const candidates = manager
    .createQueryBuilder(MangaRequestManifest, 'manga_request_manifest')
    .select('manga_request_manifest.id', 'id')
    .addSelect('manga_request_manifest.requestId', 'requestId')
    .where('manga_request_manifest.bindingState = :from', {
      from: MangaRequestBindingState.AWAITING_BINDING,
    })
    .andWhere('manga_request_manifest.frozenAt IS NULL')
    .andWhere(ACTIVE_BINDING_EXISTS, { active: MangaBindingState.ACTIVE })
    .orderBy('manga_request_manifest.id', 'ASC');
  if (anilistIds) {
    candidates.andWhere(
      'manga_request_manifest.anilistId IN (:...anilistIds)',
      {
        anilistIds,
      }
    );
  }
  const moved: number[] = [];
  for (const { id, requestId } of await candidates.getRawMany<{
    id: number | string;
    requestId: number | string;
  }>()) {
    const result = await manager
      .createQueryBuilder()
      .update(MangaRequestManifest)
      .set({
        bindingState: MangaRequestBindingState.BOUND,
        boundAt: () => 'CURRENT_TIMESTAMP',
      })
      .where('"id" = :id', { id: Number(id) })
      .andWhere('"bindingState" = :from', {
        from: MangaRequestBindingState.AWAITING_BINDING,
      })
      .andWhere('"frozenAt" IS NULL')
      .andWhere(ACTIVE_BINDING_EXISTS, { active: MangaBindingState.ACTIVE })
      .execute();
    if (result.affected === 1) {
      moved.push(Number(requestId));
    }
  }
  return moved;
};

const parkSlice = async (
  manager: EntityManager,
  anilistIds: number[] | undefined
): Promise<void> => {
  const query = manager
    .createQueryBuilder()
    .update(MangaRequestManifest)
    .set({
      bindingState: MangaRequestBindingState.AWAITING_BINDING,
      boundAt: null,
    })
    .where('"bindingState" = :from', { from: MangaRequestBindingState.BOUND })
    .andWhere('"frozenAt" IS NULL')
    .andWhere(`NOT ${ACTIVE_BINDING_EXISTS}`, {
      active: MangaBindingState.ACTIVE,
    });
  if (anilistIds) {
    query.andWhere('"anilistId" IN (:...anilistIds)', { anilistIds });
  }
  await query.execute();
};

const syncSlice = async (
  manager: EntityManager,
  anilistIds: number[] | undefined
): Promise<number[]> => {
  const moved = await bindSlice(manager, anilistIds);
  await parkSlice(manager, anilistIds);
  return moved;
};

/**
 * Brings the binding state of unfrozen manga request manifests in line with
 * the ACTIVE source bindings on each manifest's instance: parked requests
 * whose binding appeared become BOUND, and bound ones whose binding went away
 * are parked again. Every title when `anilistIds` is omitted. Returns the
 * request IDs that became BOUND, for `enqueueMangaRequestDispatch`.
 *
 * Runs on the caller's manager and takes no admission, so callers keep the
 * lock order (request admission, instance admission, transaction). It never
 * enqueues dispatch itself.
 */
export const syncMangaRequestBindings = async (
  manager: EntityManager,
  anilistIds?: readonly number[]
): Promise<number[]> => {
  if (anilistIds === undefined) {
    return syncSlice(manager, undefined);
  }
  const moved: number[] = [];
  for (const slice of chunk([...new Set(anilistIds)], SYNC_SLICE)) {
    moved.push(...(await syncSlice(manager, slice)));
  }
  return moved;
};

const queueApprovedRequests = async (
  requestIds: readonly number[],
  reader: EntityManager,
  queryRunner?: QueryRunner
): Promise<void> => {
  // Loaded on use: the request entity imports this module.
  const [{ default: requestDispatchManager }, { MediaRequest }] =
    await Promise.all([
      import('@server/lib/requestDispatch'),
      import('@server/entity/MediaRequest'),
    ]);
  for (const slice of chunk([...new Set(requestIds)], SYNC_SLICE)) {
    const rows = await reader
      .createQueryBuilder(MediaRequest, 'request')
      .select('request.id', 'id')
      .where('request.id IN (:...ids)', { ids: slice })
      .andWhere('request.type = :type', { type: MediaType.MANGA })
      .andWhere('request.status = :status', {
        status: MediaRequestStatus.APPROVED,
      })
      .orderBy('request.id', 'ASC')
      .getRawMany<{ id: number | string }>();
    for (const { id } of rows) {
      await requestDispatchManager.enqueue(Number(id), queryRunner);
    }
  }
};

/**
 * Queues dispatch for the approved manga requests among `requestIds`. With a
 * transaction's manager the outbox rows join that transaction, its errors
 * included, and dispatch starts after it commits. Otherwise they are queued
 * now and a failure is only logged: the dispatch sweep finds the requests.
 * Never waits for a dispatch.
 */
export const enqueueMangaRequestDispatch = async (
  requestIds: readonly number[],
  manager?: EntityManager
): Promise<void> => {
  if (requestIds.length === 0) {
    return;
  }
  const queryRunner = manager?.queryRunner;
  if (queryRunner?.isTransactionActive) {
    await queueApprovedRequests(requestIds, queryRunner.manager, queryRunner);
    return;
  }
  try {
    await queueApprovedRequests(requestIds, manager ?? dataSource.manager);
  } catch (error) {
    logger.warn('Manga requests could not be queued for dispatch', {
      label: 'Manga Requests',
      count: requestIds.length,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
};

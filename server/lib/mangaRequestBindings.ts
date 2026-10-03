import MangaRequestManifest, {
  MangaRequestBindingState,
} from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
} from '@server/entity/MangaSourceBinding';
import { chunk } from '@server/utils/chunk';
import type { EntityManager } from 'typeorm';

/** The most AniList IDs one sync statement carries. */
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

const syncSlice = async (
  manager: EntityManager,
  anilistIds: number[] | undefined
): Promise<void> => {
  const update = (from: MangaRequestBindingState, exists: boolean) => {
    const query = manager
      .createQueryBuilder()
      .update(MangaRequestManifest)
      .set(
        from === MangaRequestBindingState.AWAITING_BINDING
          ? {
              bindingState: MangaRequestBindingState.BOUND,
              boundAt: () => 'CURRENT_TIMESTAMP',
            }
          : {
              bindingState: MangaRequestBindingState.AWAITING_BINDING,
              boundAt: null,
            }
      )
      .where('"bindingState" = :from', { from })
      .andWhere('"frozenAt" IS NULL')
      .andWhere(
        exists ? ACTIVE_BINDING_EXISTS : `NOT ${ACTIVE_BINDING_EXISTS}`,
        {
          active: MangaBindingState.ACTIVE,
        }
      );
    if (anilistIds) {
      query.andWhere('"anilistId" IN (:...anilistIds)', { anilistIds });
    }
    return query.execute();
  };
  await update(MangaRequestBindingState.AWAITING_BINDING, true);
  await update(MangaRequestBindingState.BOUND, false);
};

/**
 * Brings the binding state of unfrozen manga request manifests in line with
 * the ACTIVE source bindings on each manifest's instance: parked requests
 * whose binding appeared become BOUND, and bound ones whose binding went away
 * are parked again. Every title when `anilistIds` is omitted.
 *
 * Runs on the caller's manager and takes no admission, so callers keep the
 * lock order (request admission, instance admission, transaction). It never
 * enqueues dispatch.
 */
export const syncMangaRequestBindings = async (
  manager: EntityManager,
  anilistIds?: readonly number[]
): Promise<void> => {
  if (anilistIds === undefined) {
    await syncSlice(manager, undefined);
    return;
  }
  for (const slice of chunk([...new Set(anilistIds)], SYNC_SLICE)) {
    await syncSlice(manager, slice);
  }
};

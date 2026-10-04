import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import { MediaRequestStatus } from '@server/constants/media';
import dataSource from '@server/datasource';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceResolution, {
  MangaResolutionStatus,
} from '@server/entity/MangaSourceResolution';
import { runWithRequestAdmission } from '@server/entity/MediaRequest';
import {
  MANGA_IN_LIST_LIMIT,
  getMangaAdmissionKey,
} from '@server/lib/mangaMedia';
import { hasActiveMangaBinding } from '@server/lib/mangaRequestBindings';
import { MangaResolveError } from '@server/lib/mangaResolver/errors';
import { chunk } from '@server/utils/chunk';
import { In, type EntityManager } from 'typeorm';

/** A requested title that waits for a source binding on one instance. */
export interface WaitingMangaTitle {
  instanceId: number;
  anilistId: number;
  /** The oldest open request on the title. */
  requestId: number;
  /** Whether an approved request waits; pending ones need an admin search. */
  approved: boolean;
  /** Whether the title's manifests still wait for a binding. */
  waiting: boolean;
}

/**
 * Titles with an unfrozen manifest of a pending or approved request, oldest
 * request first: by default only those still waiting for a binding.
 */
export const findWaitingMangaTitles = async (
  manager: EntityManager,
  filter: { instanceId?: number; anilistId?: number; bound?: boolean } = {}
): Promise<WaitingMangaTitle[]> => {
  const query = manager
    .createQueryBuilder(MangaRequestManifest, 'manifest')
    .innerJoin('manifest.request', 'request')
    .select('manifest.instanceId', 'instanceId')
    .addSelect('manifest.anilistId', 'anilistId')
    .addSelect('MIN(manifest.requestId)', 'requestId')
    .addSelect(
      'MAX(CASE WHEN request.status = :approved THEN 1 ELSE 0 END)',
      'approved'
    )
    .addSelect(
      'MAX(CASE WHEN manifest.bindingState = :awaiting THEN 1 ELSE 0 END)',
      'waiting'
    )
    .where('manifest.frozenAt IS NULL')
    .andWhere('request.status IN (:...statuses)', {
      statuses: [MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED],
    })
    .setParameter('approved', MediaRequestStatus.APPROVED)
    .setParameter('awaiting', MangaRequestBindingState.AWAITING_BINDING)
    .groupBy('manifest.instanceId')
    .addGroupBy('manifest.anilistId');
  if (!filter.bound) {
    query.andWhere('manifest.bindingState = :awaiting');
  }
  if (filter.instanceId !== undefined) {
    query.andWhere('manifest.instanceId = :instanceId', {
      instanceId: filter.instanceId,
    });
  }
  if (filter.anilistId !== undefined) {
    query.andWhere('manifest.anilistId = :anilistId', {
      anilistId: filter.anilistId,
    });
  }
  const rows =
    await query.getRawMany<Record<keyof WaitingMangaTitle, unknown>>();
  return rows
    .map((row) => ({
      instanceId: Number(row.instanceId),
      anilistId: Number(row.anilistId),
      requestId: Number(row.requestId),
      approved: Number(row.approved) === 1,
      waiting: Number(row.waiting) === 1,
    }))
    .sort((a, b) => a.requestId - b.requestId);
};

export const resolutionKey = (instanceId: number, anilistId: number) =>
  `${instanceId}:${anilistId}`;

/** The resolver rows of the given titles, by `resolutionKey`. */
export const loadMangaResolutions = async (
  manager: EntityManager,
  titles: readonly Pick<WaitingMangaTitle, 'instanceId' | 'anilistId'>[]
): Promise<Map<string, MangaSourceResolution>> => {
  const found = new Map<string, MangaSourceResolution>();
  const ids = [...new Set(titles.map(({ anilistId }) => anilistId))];
  for (const slice of chunk(ids, MANGA_IN_LIST_LIMIT)) {
    const rows = await manager.find(MangaSourceResolution, {
      where: { anilistId: In(slice) },
    });
    for (const row of rows) {
      found.set(resolutionKey(row.instanceId, row.anilistId), row);
    }
  }
  return found;
};

/**
 * Whether a run may search the title: an approved request waits, or an admin
 * asked for the search.
 */
export const isMangaTitleSearchable = (
  title: WaitingMangaTitle,
  row: MangaSourceResolution | undefined
): boolean => title.approved || row?.searchRequestedAt != null;

/**
 * Whether the title's next search is due. A bound row has no next attempt,
 * so a title that lost its binding is due at once; a search of it that fails
 * then waits like any other.
 */
export const isMangaTitleDue = (
  row: MangaSourceResolution | undefined,
  now: Date
): boolean =>
  !row ||
  row.searchRequestedAt !== null ||
  row.nextAttemptAt === null ||
  row.nextAttemptAt.getTime() <= now.getTime();

/**
 * Makes the title due at once with a fresh backoff, pending requests
 * included: an admin's search is the approval to search. Touches only the
 * database; the caller starts the job. A title with an ACTIVE binding on the
 * instance gets 409.
 */
export const requestMangaTitleSearch = (
  instanceId: number,
  anilistId: number
): Promise<void> =>
  runWithRequestAdmission([getMangaAdmissionKey(anilistId)], () =>
    dataSource.transaction(async (manager) => {
      if (await hasActiveMangaBinding(manager, anilistId, instanceId)) {
        throw new MangaResolveError('MANGA_ALREADY_BOUND');
      }
      const row =
        (await manager.findOneBy(MangaSourceResolution, {
          instanceId,
          anilistId,
        })) ?? new MangaSourceResolution({ instanceId, anilistId });
      row.status = MangaResolutionStatus.QUEUED;
      row.reason = null;
      row.attempts = 0;
      row.nextAttemptAt = null;
      row.lastError = null;
      row.searchRequestedAt = new Date();
      await manager.save(row);
    })
  );

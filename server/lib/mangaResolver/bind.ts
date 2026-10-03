import { MediaStatus } from '@server/constants/media';
import dataSource from '@server/datasource';
import MangaSourceBinding, {
  MANGA_BINDING_ORIGIN_ADMIN,
  MANGA_BINDING_ORIGIN_RESOLVER,
  MANGA_MATCHED_BY_MANGADEX_LINK,
  MANGA_MATCHED_BY_MANUAL,
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import { runWithRequestAdmission } from '@server/entity/MediaRequest';
import {
  getMangaAdmissionKey,
  newMangaMediaTally,
  reconcileMangaMedia,
} from '@server/lib/mangaMedia';
import {
  hasActiveMangaBinding,
  syncMangaRequestBindings,
} from '@server/lib/mangaRequestBindings';
import { MangaResolveError } from '@server/lib/mangaResolver/errors';
import type { SuwayomiSettings } from '@server/lib/settings';
import {
  SuwayomiInstanceChangedError,
  runWithSuwayomiInstanceAdmission,
} from '@server/lib/suwayomi/instanceAdmission';
import logger from '@server/logger';
import { isUniqueConstraintError } from '@server/utils/databaseError';

const LABEL = 'Manga Source Resolve';

/** A source manga outside the Suwayomi library, read before any lock. */
export interface MangaResolverItem {
  snapshot: SuwayomiSettings;
  anilistId: number;
  sourceId: string;
  url: string;
  suwayomiMangaId: number;
  title: string;
  /** Matched through an exact MangaDex link, not chosen by hand. */
  exact: boolean;
}

export type MangaResolverBindResult =
  | { outcome: 'bound' | 'unchanged'; binding: MangaSourceBinding }
  | {
      outcome: 'skipped';
      reason: 'EXISTING_BINDING' | 'BOUND_ELSEWHERE' | 'REJECTED';
    };

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : 'UNKNOWN';

/**
 * Media and the title's requests follow its bindings. Runs inside the
 * caller's admissions; a failure only logs, since the binding stands.
 */
const reconcileAfter = async (instanceId: number, anilistId: number) => {
  try {
    await reconcileMangaMedia([anilistId], {
      completedInstanceIds: new Set([instanceId]),
      tally: newMangaMediaTally(),
      admitted: true,
    });
    return;
  } catch (error) {
    logger.warn('Manga media reconcile failed after a source binding', {
      label: LABEL,
      instanceId,
      anilistId,
      code: errorName(error),
    });
  }
  try {
    await syncMangaRequestBindings(dataSource.manager, [anilistId]);
  } catch (error) {
    logger.warn('Manga request binding sync failed after a source binding', {
      label: LABEL,
      instanceId,
      anilistId,
      code: errorName(error),
    });
  }
};

const translateWriteError = (error: unknown): never => {
  if (error instanceof SuwayomiInstanceChangedError) {
    throw new MangaResolveError('MANGA_INSTANCE_CHANGED');
  }
  if (isUniqueConstraintError(error)) {
    throw new MangaResolveError('MANGA_UNIQUE_CONFLICT');
  }
  throw error;
};

/**
 * Binds a source manga outside the library to the title, as an ACTIVE row
 * that is not in the library yet. Takes the title's request admission, then
 * the instance's, then one transaction that re-reads every row it decides
 * on; no outside call happens under them.
 *
 * `auto` never binds a title that has an ACTIVE binding on the instance, an
 * item bound to another title, or a pair an admin rejected. `admin` gets a
 * 409 for an item bound to another title and may revive a rejected pair. An
 * item already bound to the title is left as it is.
 */
export const writeMangaResolverBinding = (
  item: MangaResolverItem,
  mode: 'auto' | 'admin',
  signal?: AbortSignal
): Promise<MangaResolverBindResult> => {
  const { snapshot, anilistId, sourceId, url } = item;
  const instanceId = snapshot.id;
  return runWithRequestAdmission([getMangaAdmissionKey(anilistId)], () =>
    runWithSuwayomiInstanceAdmission(snapshot, async () => {
      const result = await dataSource.transaction(
        async (manager): Promise<MangaResolverBindResult> => {
          signal?.throwIfAborted();
          if (
            mode === 'auto' &&
            (await hasActiveMangaBinding(manager, anilistId, instanceId))
          ) {
            return { outcome: 'skipped', reason: 'EXISTING_BINDING' };
          }
          const urlHash = hashMangaSourceUrl(url);
          const rows = (
            await manager.find(MangaSourceBinding, {
              where: { instanceId, sourceId, urlHash },
              order: { id: 'ASC' },
            })
          ).filter((row) => row.url === url);
          const live = rows.find(
            (row) => row.state !== MangaBindingState.REJECTED
          );
          if (live && live.anilistId !== anilistId) {
            if (mode === 'admin') {
              throw new MangaResolveError('MANGA_ITEM_BOUND_ELSEWHERE');
            }
            return { outcome: 'skipped', reason: 'BOUND_ELSEWHERE' };
          }
          if (live?.state === MangaBindingState.ACTIVE) {
            return { outcome: 'unchanged', binding: live };
          }
          // The pair key allows one row per item and title, in any state.
          const pair = rows.find((row) => row.anilistId === anilistId);
          if (pair?.state === MangaBindingState.REJECTED && mode === 'auto') {
            return { outcome: 'skipped', reason: 'REJECTED' };
          }
          const values = {
            confidence: item.exact
              ? MangaBindingConfidence.EXACT_LINK
              : MangaBindingConfidence.MANUAL,
            matchedBy: item.exact
              ? MANGA_MATCHED_BY_MANGADEX_LINK
              : MANGA_MATCHED_BY_MANUAL,
            origin:
              mode === 'auto'
                ? MANGA_BINDING_ORIGIN_RESOLVER
                : MANGA_BINDING_ORIGIN_ADMIN,
            state: MangaBindingState.ACTIVE,
            inLibrary: false,
            availability: MediaStatus.UNKNOWN,
            chapterCount: null,
            downloadCount: null,
            suwayomiMangaId: item.suwayomiMangaId,
            title: item.title,
          };
          if (pair) {
            await manager.update(MangaSourceBinding, pair.id, values);
            return {
              outcome: 'bound',
              binding: await manager.findOneByOrFail(MangaSourceBinding, {
                id: pair.id,
              }),
            };
          }
          const binding = await manager.save(
            new MangaSourceBinding({
              instanceId,
              sourceId,
              url,
              urlHash,
              anilistId,
              ...values,
            })
          );
          return { outcome: 'bound', binding };
        }
      );
      if (result.outcome === 'bound') {
        logger.info('Manga title bound to a source manga', {
          label: LABEL,
          instanceId,
          anilistId,
          bindingId: result.binding.id,
          origin: result.binding.origin,
          confidence: result.binding.confidence,
        });
      }
      if (result.outcome !== 'skipped') {
        await reconcileAfter(instanceId, anilistId);
      }
      return result;
    })
  ).catch(translateWriteError);
};

/**
 * Lets the requests of a title that already has an ACTIVE binding catch up,
 * under the same locks as a binding write.
 */
export const catchUpMangaResolverTitle = (
  snapshot: SuwayomiSettings,
  anilistId: number
): Promise<void> =>
  runWithRequestAdmission([getMangaAdmissionKey(anilistId)], () =>
    runWithSuwayomiInstanceAdmission(snapshot, () =>
      reconcileAfter(snapshot.id, anilistId)
    )
  ).catch(translateWriteError);

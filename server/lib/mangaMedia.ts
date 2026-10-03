import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource from '@server/datasource';
import MangaSourceBinding, {
  MangaBindingState,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import {
  MediaRequest,
  runWithRequestAdmission,
} from '@server/entity/MediaRequest';
import type { SuwayomiSettings } from '@server/lib/settings';
import { runWithSuwayomiInstanceAdmission } from '@server/lib/suwayomi/instanceAdmission';
import { chunk } from '@server/utils/chunk';
import { isUniqueConstraintError } from '@server/utils/databaseError';
import { In, type EntityManager } from 'typeorm';

/** The most values one `IN (...)` list may carry. */
export const MANGA_IN_LIST_LIMIT = 500;

/** The request admission key every writer of one manga's media takes. */
export const getMangaAdmissionKey = (anilistId: number): string =>
  `request-canonical:manga:${MediaIdentifierProvider.ANILIST}:${anilistId}`;

export type MangaBindingSummary = Pick<
  MangaSourceBinding,
  'instanceId' | 'state' | 'inLibrary' | 'availability'
>;

const rank = (status: MediaStatus | undefined): number =>
  status === MediaStatus.AVAILABLE
    ? 2
    : status === MediaStatus.PARTIALLY_AVAILABLE
      ? 1
      : 0;

/**
 * The status a manga's bindings ask for, or undefined for no change. `current`
 * is undefined when no media exists yet; one is created only to record
 * availability.
 *
 * Only bindings on completed instances (whose reads finished this run) set the
 * target, and an upgrade applies from it. A downgrade waits while an
 * in-library binding sits on any other instance, and never happens while the
 * media has an active request. UNKNOWN is the floor; BLOCKLISTED is never
 * touched.
 */
export const decideMangaStatus = ({
  current,
  bindings,
  completedInstanceIds,
  activeRequest,
}: {
  current: MediaStatus | undefined;
  bindings: readonly MangaBindingSummary[];
  completedInstanceIds: ReadonlySet<number>;
  activeRequest: boolean;
}): MediaStatus | undefined => {
  const inLibrary = bindings.filter(
    (binding) => binding.state === MangaBindingState.ACTIVE && binding.inLibrary
  );
  const target = inLibrary
    .filter((binding) => completedInstanceIds.has(binding.instanceId))
    .reduce<MediaStatus>(
      (best, binding) =>
        rank(binding.availability) > rank(best) ? binding.availability : best,
      MediaStatus.UNKNOWN
    );
  if (current === undefined) return rank(target) > 0 ? target : undefined;
  if (current === MediaStatus.BLOCKLISTED) return undefined;
  if (rank(target) > rank(current)) return target;
  if (rank(target) === rank(current)) return undefined;
  const waiting =
    activeRequest ||
    inLibrary.some((binding) => !completedInstanceIds.has(binding.instanceId));
  return waiting ? undefined : target;
};

/**
 * Manga media by AniList ID. `null` marks an AniList ID that belongs to media
 * of another type: an identity conflict callers must leave alone.
 */
export const findMangaMedia = async (
  manager: EntityManager,
  anilistIds: readonly number[]
): Promise<Map<number, Media | null>> => {
  const found = new Map<number, Media | null>();
  const values = [...new Set(anilistIds)].map(String);
  for (const slice of chunk(values, MANGA_IN_LIST_LIMIT)) {
    const identifiers = await manager.find(MediaIdentifier, {
      where: { provider: MediaIdentifierProvider.ANILIST, value: In(slice) },
      relations: { media: true },
      relationLoadStrategy: 'query',
    });
    for (const identifier of identifiers) {
      found.set(
        Number(identifier.value),
        identifier.media?.mediaType === MediaType.MANGA
          ? identifier.media
          : null
      );
    }
  }
  return found;
};

/** Media IDs with a pending, approved or failed request. */
export const findMediaWithActiveRequests = async (
  manager: EntityManager,
  mediaIds: readonly number[]
): Promise<Set<number>> => {
  const active = new Set<number>();
  for (const slice of chunk([...new Set(mediaIds)], MANGA_IN_LIST_LIMIT)) {
    const rows = await manager
      .createQueryBuilder(MediaRequest, 'request')
      .innerJoin('request.media', 'media')
      .select('media.id', 'mediaId')
      .distinct(true)
      .where('media.id IN (:...slice)', { slice })
      .andWhere('request.status IN (:...statuses)', {
        statuses: [
          MediaRequestStatus.PENDING,
          MediaRequestStatus.APPROVED,
          MediaRequestStatus.FAILED,
        ],
      })
      .getRawMany<{ mediaId: unknown }>();
    for (const row of rows) active.add(Number(row.mediaId));
  }
  return active;
};

/** Creates available manga media under its canonical AniList identity. */
export const createMangaMedia = async (
  manager: EntityManager,
  anilistId: number,
  status: MediaStatus
): Promise<Media> => {
  const media = await manager.save(
    new Media({
      tmdbId: 0,
      mediaType: MediaType.MANGA,
      status,
      status4k: MediaStatus.UNKNOWN,
      mediaAddedAt: new Date(),
    })
  );
  await manager.save(
    new MediaIdentifier({
      media,
      provider: MediaIdentifierProvider.ANILIST,
      value: String(anilistId),
      canonical: true,
    })
  );
  return media;
};

/** What one media reconcile did, kept when it stops early. */
export interface MangaMediaTally {
  mediaCreated: number;
  mediaUpdated: number;
  /** Titles skipped because their write hit a unique key. */
  uniqueConflicts: number;
  /** Titles whose AniList ID belongs to media of another type. */
  identityConflicts: number;
}

export const newMangaMediaTally = (): MangaMediaTally => ({
  mediaCreated: 0,
  mediaUpdated: 0,
  uniqueConflicts: 0,
  identityConflicts: 0,
});

/** The statuses to write, by AniList ID, for at most 500 IDs. */
const decideMangaMedia = async (
  manager: EntityManager,
  anilistIds: readonly number[],
  completed: ReadonlySet<number>
) => {
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
    bindings.set(row.anilistId, [...(bindings.get(row.anilistId) ?? []), row]);
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
};

const applyMangaMediaChange = async (
  manager: EntityManager,
  anilistId: number,
  completed: ReadonlySet<number>
): Promise<'mediaCreated' | 'mediaUpdated' | undefined> => {
  const { changes } = await decideMangaMedia(manager, [anilistId], completed);
  const change = changes.get(anilistId);
  if (!change) return undefined;
  if (!change.media) {
    await createMangaMedia(manager, anilistId, change.status);
    return 'mediaCreated';
  }
  change.media.status = change.status;
  await manager.save(change.media);
  return 'mediaUpdated';
};

/**
 * Brings each title's media status in line with its bindings. Decisions are
 * made in bulk; a mismatch takes the locks and is decided again inside them
 * before anything is written. A write that hits a unique key skips its
 * title; any other error stops the reconcile.
 */
export const reconcileMangaMedia = async (
  anilistIds: readonly number[],
  {
    completedInstanceIds,
    tally,
    signal,
    snapshot,
    serialize,
    admitted = false,
  }: {
    /** Instances whose bindings are current enough to raise a status. */
    completedInstanceIds: ReadonlySet<number>;
    tally: MangaMediaTally;
    /** Checked before each batch and inside each write. */
    signal?: AbortSignal;
    /** Each write also takes this instance's admission. */
    snapshot?: SuwayomiSettings;
    /** The caller's own lock for one title, inside its request admission. */
    serialize?: <Result>(
      anilistId: number,
      write: () => Promise<Result>
    ) => Promise<Result>;
    /** The caller already holds every admission these titles need. */
    admitted?: boolean;
  }
): Promise<void> => {
  const ids = [...new Set(anilistIds)].sort((a, b) => a - b);
  for (const slice of chunk(ids, MANGA_IN_LIST_LIMIT)) {
    if (signal?.aborted) return;
    const decided = await decideMangaMedia(
      dataSource.manager,
      slice,
      completedInstanceIds
    );
    tally.identityConflicts += decided.conflicts;
    for (const anilistId of decided.changes.keys()) {
      // Request admission, then the caller's lock, then the instance's
      // admission, then the transaction.
      const write = () =>
        dataSource.transaction((manager) => {
          signal?.throwIfAborted();
          return applyMangaMediaChange(
            manager,
            anilistId,
            completedInstanceIds
          );
        });
      const admit = () =>
        snapshot ? runWithSuwayomiInstanceAdmission(snapshot, write) : write();
      try {
        const counter = admitted
          ? await write()
          : await runWithRequestAdmission(
              [getMangaAdmissionKey(anilistId)],
              () => (serialize ? serialize(anilistId, admit) : admit())
            );
        if (counter) tally[counter] += 1;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        tally.uniqueConflicts += 1;
      }
    }
  }
};

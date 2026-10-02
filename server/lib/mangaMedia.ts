import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import {
  MangaBindingState,
  type default as MangaSourceBinding,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { MediaRequest } from '@server/entity/MediaRequest';
import { chunk } from '@server/utils/chunk';
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

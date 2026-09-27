import type JellyfinAPI from '@server/api/jellyfin';
import type PlexAPI from '@server/api/plexapi';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import dataSource, { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import Season from '@server/entity/Season';
import { Watchlist } from '@server/entity/Watchlist';
import { runMediaEntityMutation } from '@server/lib/mediaMutation';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import logger from '@server/logger';

export type LibraryPresence = 'present' | 'absent' | 'unknown';
export type VideoLibraryPresence = [LibraryPresence, LibraryPresence];

export const mediaServerDeletionPresence = async (
  media: Media,
  is4k: boolean,
  type: MediaServerType,
  plex?: Pick<PlexAPI, 'getMetadata' | 'getStatus'>,
  jellyfin?: Pick<JellyfinAPI, 'getItemDataForDeletionCheck' | 'getSystemInfo'>,
  expectedPlexMachineId?: string
): Promise<LibraryPresence> => {
  const key =
    type === MediaServerType.PLEX
      ? media[is4k ? 'ratingKey4k' : 'ratingKey']
      : media[is4k ? 'jellyfinMediaId4k' : 'jellyfinMediaId'];
  const otherKey =
    media.mediaType === MediaType.MOVIE
      ? type === MediaServerType.PLEX
        ? media[is4k ? 'ratingKey' : 'ratingKey4k']
        : media[is4k ? 'jellyfinMediaId' : 'jellyfinMediaId4k']
      : undefined;
  const keys = [
    ...new Set([key, otherKey].filter((value): value is string => !!value)),
  ];
  // No stored key is not proof of absence for a previously available copy.
  if (!keys.length) return 'unknown';
  // A 404 from a wrong/dead service route is not an item deletion. Verify the
  // server itself separately so its failure cannot become absence evidence.
  const results: LibraryPresence[] = [];
  for (const candidateKey of keys) {
    try {
      if (type === MediaServerType.PLEX) {
        if (
          !plex ||
          !expectedPlexMachineId ||
          (await plex.getStatus()).MediaContainer.machineIdentifier !==
            expectedPlexMachineId
        )
          return 'unknown';
      } else if (!jellyfin || !(await jellyfin.getSystemInfo()).Id)
        return 'unknown';
    } catch {
      return 'unknown';
    }
    try {
      if (type === MediaServerType.PLEX) {
        if (!plex) return 'unknown';
        const item = await plex.getMetadata(candidateKey);
        if (!item || item.ratingKey !== candidateKey) return 'unknown';
        if (media.mediaType !== MediaType.MOVIE) return 'present';
        // A Plex movie key may represent both HD and 4K versions. Only use
        // resolution evidence when the canonical identity and every stream agree.
        if (
          !item.Guid?.some((guid) => guid.id === `tmdb://${media.tmdbId}`) ||
          !item.Media?.length
        )
          return 'present';
        const qualities = item.Media.map((stream) =>
          stream.videoResolution === '4k' || stream.height >= 2160
            ? true
            : stream.height > 0 && stream.height < 2160
              ? false
              : undefined
        );
        if (qualities.includes(undefined)) return 'unknown';
        if (qualities.includes(is4k)) return 'present';
        results.push('absent');
        continue;
      }
      if (
        !jellyfin ||
        ![MediaServerType.JELLYFIN, MediaServerType.EMBY].includes(type)
      )
        return 'unknown';
      if (await jellyfin.getItemDataForDeletionCheck(candidateKey))
        return 'present';
      results.push('absent');
    } catch (error) {
      results.push(confirmedNotFound(error) ? 'absent' : 'unknown');
    }
  }
  return results.includes('unknown') ? 'unknown' : 'absent';
};

// Do not interpret an exception message containing "404" as proof of deletion.
export const confirmedNotFound = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === 'object' && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const item = current as {
      status?: number;
      statusCode?: number;
      response?: { status?: number };
      cause?: unknown;
    };
    if ((item.response?.status ?? item.statusCode ?? item.status) === 404)
      return true;
    current = item.cause;
  }
  return false;
};

const screenMedia = (media: Media) =>
  media.mediaType === MediaType.MOVIE || media.mediaType === MediaType.TV;
const knownCopy = (media: Media, is4k: boolean): boolean =>
  [
    MediaStatus.AVAILABLE,
    MediaStatus.PARTIALLY_AVAILABLE,
    MediaStatus.DELETED,
  ].includes(media[is4k ? 'status4k' : 'status']) ||
  !!media[is4k ? 'ratingKey4k' : 'ratingKey'] ||
  !!media[is4k ? 'jellyfinMediaId4k' : 'jellyfinMediaId'] ||
  media[is4k ? 'externalServiceId4k' : 'externalServiceId'] != null;

export const deletionSnapshot = (media: Media): string =>
  JSON.stringify([
    media.id,
    media.mediaType,
    media.tmdbId,
    media.tvdbId,
    media.updatedAt,
    media.status,
    media.status4k,
    media.serviceId,
    media.serviceId4k,
    media.externalServiceId,
    media.externalServiceId4k,
    media.ratingKey,
    media.ratingKey4k,
    media.jellyfinMediaId,
    media.jellyfinMediaId4k,
  ]);

// Caller holds canonical media + configuration/service/owner admissions.
// This transaction makes no calls to Arr or a media server and never deletes files.
export const applyConfirmedVideoDeletion = async (
  snapshot: Media,
  presence: VideoLibraryPresence
): Promise<'unchanged' | 'updated' | 'retained' | 'removed'> => {
  if (
    !screenMedia(snapshot) ||
    presence.includes('unknown') ||
    !presence.includes('absent') ||
    ![false, true].some((q) => knownCopy(snapshot, q))
  )
    return 'unchanged';
  return dataSource.transaction(async (manager) => {
    const media = await manager.findOne(Media, { where: { id: snapshot.id } });
    if (!media || deletionSnapshot(media) !== deletionSnapshot(snapshot))
      return 'unchanged';
    // Never race an accepted request that is still being dispatched to Arr.
    if (
      await manager.exists(RequestDispatchOutbox, {
        where: { request: { media: { id: media.id } } },
      })
    )
      return 'unchanged';
    const blocklist = await manager.findOne(Blocklist, {
      where: [
        { media: { id: media.id } },
        { mediaType: media.mediaType, tmdbId: media.tmdbId },
      ],
    });
    const patch: Partial<Media> = {};
    for (const is4k of [false, true]) {
      if (presence[is4k ? 1 : 0] !== 'absent' || !knownCopy(media, is4k))
        continue;
      const status = is4k ? 'status4k' : 'status';
      patch[status] = blocklist ? MediaStatus.BLOCKLISTED : MediaStatus.DELETED;
      Object.assign(
        patch,
        is4k
          ? {
              serviceId4k: null,
              externalServiceId4k: null,
              externalServiceSlug4k: null,
              ratingKey4k: null,
              jellyfinMediaId4k: null,
            }
          : {
              serviceId: null,
              externalServiceId: null,
              externalServiceSlug: null,
              ratingKey: null,
              jellyfinMediaId: null,
            }
      );
      await manager
        .createQueryBuilder()
        .update(Season)
        .set({ [status]: MediaStatus.DELETED })
        .where('mediaId = :id', { id: media.id })
        .callListeners(false)
        .execute();
      if (blocklist) {
        await manager.update(Blocklist, blocklist.id, {
          [is4k ? 'previousStatus4k' : 'previousStatus']: MediaStatus.DELETED,
        });
      }
    }
    const lastCopyGone = presence.every((state) => state === 'absent');
    if (lastCopyGone) {
      await manager.delete(Issue, { media: { id: media.id } });
      await manager.delete(MediaRequest, { media: { id: media.id } });
      const watched = await manager.exists(Watchlist, {
        where: [
          { media: { id: media.id } },
          { mediaType: media.mediaType, tmdbId: media.tmdbId },
        ],
      });
      // A legacy BLOCKLISTED flag without its relation is ambiguous: preserve it.
      if (
        !blocklist &&
        !watched &&
        media.status !== MediaStatus.BLOCKLISTED &&
        media.status4k !== MediaStatus.BLOCKLISTED
      ) {
        await manager.delete(Media, media.id);
        return 'removed';
      }
      // Do not let an unblocked title regain the old Available state.
      if (blocklist)
        await manager.update(Blocklist, blocklist.id, {
          previousStatus: MediaStatus.DELETED,
          previousStatus4k: MediaStatus.DELETED,
        });
    }
    if (Object.keys(patch).length)
      await manager
        .createQueryBuilder()
        .update(Media)
        .set(patch)
        .where('id = :id', { id: media.id })
        .callListeners(false)
        .execute();
    return lastCopyGone
      ? 'retained'
      : Object.keys(patch).length
        ? 'updated'
        : 'unchanged';
  });
};

type Context = {
  radarr: RadarrSettings[];
  sonarr: SonarrSettings[];
  mediaServerPresence: (
    media: Media,
    is4k: boolean
  ) => Promise<LibraryPresence>;
  withOwnerAuthority: <T>(callback: () => Promise<T>) => Promise<T>;
  withAuthority: <T>(media: Media, callback: () => Promise<T>) => Promise<T>;
  cancelled: () => boolean;
};

export class LibraryDeletionReconciler {
  private inventories = new Map<
    string,
    Promise<{ is4k: boolean; ids: Set<number> }[]>
  >();
  constructor(private readonly context: Context) {}

  private async inventory(media: Media, fresh = false) {
    const key = media.mediaType;
    if (fresh || !this.inventories.has(key)) {
      const read = async () => {
        const result: { is4k: boolean; ids: Set<number> }[] = [];
        const services =
          media.mediaType === MediaType.MOVIE
            ? this.context.radarr
            : this.context.sonarr;
        if (!services.length || services.some((server) => !server.syncEnabled))
          throw new Error('Incomplete sync authority');
        for (const server of services) {
          if (media.mediaType === MediaType.MOVIE) {
            const client = new RadarrAPI({
              apiKey: server.apiKey,
              url: RadarrAPI.buildUrl(server, '/api/v3'),
            });
            const items = await client.getMovies({
              strict: true,
              ...(fresh ? { tmdbId: media.tmdbId } : {}),
            });
            result.push({
              is4k: !!server.is4k,
              ids: new Set(items.map((item) => item.tmdbId)),
            });
          } else {
            const client = new SonarrAPI({
              apiKey: server.apiKey,
              url: SonarrAPI.buildUrl(server, '/api/v3'),
            });
            const items = await client.getSeries({
              strict: true,
              ...(fresh && media.tvdbId ? { tvdbId: media.tvdbId } : {}),
            });
            result.push({
              is4k: !!server.is4k,
              ids: new Set(items.map((item) => item.tvdbId)),
            });
          }
        }
        return result;
      };
      if (fresh) return read();
      this.inventories.set(key, read());
    }
    return this.inventories.get(key)!;
  }

  private async probe(
    media: Media,
    fresh = false
  ): Promise<VideoLibraryPresence> {
    const id =
      media.mediaType === MediaType.MOVIE ? media.tmdbId : media.tvdbId;
    if (!id || !Number.isSafeInteger(id) || id <= 0)
      return ['unknown', 'unknown'];
    try {
      const inventory = await this.inventory(media, fresh);
      const result: VideoLibraryPresence = ['unknown', 'unknown'];
      for (const is4k of [false, true]) {
        // Keep requests for entries still in Arr, even if files are being replaced.
        if (
          inventory.some((source) => source.is4k === is4k && source.ids.has(id))
        )
          result[is4k ? 1 : 0] = 'present';
        else if (
          !knownCopy(media, is4k) &&
          !(
            media.mediaType === MediaType.MOVIE &&
            (media.ratingKey ||
              media.ratingKey4k ||
              media.jellyfinMediaId ||
              media.jellyfinMediaId4k)
          )
        )
          result[is4k ? 1 : 0] = 'absent';
        else
          result[is4k ? 1 : 0] = await this.context.mediaServerPresence(
            media,
            is4k
          );
      }
      return result;
    } catch {
      return ['unknown', 'unknown'];
    }
  }

  async reconcile(snapshot: Media): Promise<void> {
    if (!screenMedia(snapshot) || this.context.cancelled()) return;
    const first = await this.probe(snapshot);
    if (
      first.includes('unknown') ||
      ![false, true].some(
        (q) => first[q ? 1 : 0] === 'absent' && knownCopy(snapshot, q)
      )
    )
      return;
    await this.context.withOwnerAuthority(() =>
      runMediaEntityMutation(snapshot, () =>
        this.context.withAuthority(snapshot, async () => {
          if (this.context.cancelled()) return;
          const current = await getRepository(Media).findOneBy({
            id: snapshot.id,
          });
          if (
            !current ||
            deletionSnapshot(current) !== deletionSnapshot(snapshot)
          )
            return;
          // Recheck live services under the same admissions that protect requests.
          const confirmed = await this.probe(current, true);
          if (
            this.context.cancelled() ||
            JSON.stringify(first) !== JSON.stringify(confirmed)
          )
            return;
          const outcome = await applyConfirmedVideoDeletion(current, confirmed);
          if (outcome !== 'unchanged')
            logger.info('Reconciled confirmed library removal.', {
              label: 'AvailabilitySync',
              mediaId: current.id,
              mediaType: current.mediaType,
              outcome,
            });
        })
      )
    );
  }
}

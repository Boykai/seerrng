import TheMovieDb from '@server/api/themoviedb';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { CollectionLink } from '@server/entity/CollectionLink';
import type { CollectionSyncStatus } from '@server/interfaces/api/collectionSync';
import {
  captureConfigurationAuthority,
  runWithConfigurationSnapshot,
} from '@server/lib/configurationAdmission';
import {
  captureMediaServerUserAuthority,
  runWithMediaServerUserAuthority,
} from '@server/lib/mediaServerUserAuthority';
import requestAdmission from '@server/lib/requestAdmission';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { CollectionKind } from '@server/models/CuratedCollection';
import { mapWithConcurrency } from '@server/utils/concurrency';
import { createHash } from 'node:crypto';
import { getCuratedCollection } from './collectionCatalog';
import {
  configuredCollectionServerId,
  getCollectionServer,
  type CollectionMovie,
} from './collectionServers';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const results = new Map<
  string,
  { expires: number; value: CollectionSyncStatus }
>();
const lookups = new Map<
  string,
  { expires: number; value: CollectionMovie[] }
>();
export const collectionLinkId = (
  serverId: string,
  collectionId: number | string,
  libraryId: string,
  kind: CollectionKind = 'movie'
) =>
  kind === 'movie'
    ? digest([serverId, Number(collectionId), libraryId])
    : digest([serverId, kind, collectionId, libraryId]);
export interface CollectionRemoval {
  libraryId: string;
  removalToken: string;
}

/** Reuse normal scanner persistence and request-completion behavior. */
class CollectionAvailabilityScanner extends BaseScanner<CollectionMovie> {
  constructor() {
    super('Collection Availability');
    this.enable4kMovie = true;
  }
  public async accept(tmdbId: number, item: CollectionMovie): Promise<void> {
    for (const is4k of item.qualities) {
      await this.processMovie(tmdbId, {
        is4k,
        title: item.title,
        mediaAddedAt: item.addedAt,
        ...(getSettings().main.mediaServerType === MediaServerType.PLEX
          ? { ratingKey: item.id }
          : { jellyfinMediaId: item.id }),
      });
    }
  }
}

export const checkCollection = async (
  collectionId: number | string,
  pushLibraries?: string[],
  removals?: CollectionRemoval[],
  options: { kind?: CollectionKind; selectedIds?: string[] } = {}
): Promise<CollectionSyncStatus> => {
  const settings = getSettings();
  const kind = options.kind ?? 'movie';
  const storedCollectionId = kind === 'music' ? 0 : Number(collectionId);
  if (
    ![
      MediaServerType.PLEX,
      MediaServerType.JELLYFIN,
      MediaServerType.EMBY,
    ].includes(settings.main.mediaServerType)
  ) {
    return { supported: false, checkedAt: Date.now(), destinations: [] };
  }
  if (pushLibraries && removals)
    throw new Error('Select only one collection action.');
  const section =
    settings.main.mediaServerType === MediaServerType.PLEX
      ? 'plex'
      : 'jellyfin';
  const configuration = captureConfigurationAuthority(section);
  const owner = await captureMediaServerUserAuthority(1, section);
  const scope = digest([configuration.authorityKey, owner]);
  const key = scope + ':' + kind + ':' + collectionId;
  const refreshes = new Map<string, () => Promise<void>>();
  const result = await runWithMediaServerUserAuthority(owner, () =>
    runWithConfigurationSnapshot(configuration, () =>
      requestAdmission.run(['collection-sync:' + key], async () => {
        const server = getCollectionServer(owner, kind);
        const cached = results.get(key);
        if (
          !pushLibraries &&
          !removals &&
          cached &&
          cached.expires > Date.now()
        )
          return cached.value;
        if (pushLibraries || removals) results.delete(key);
        const deadline = Date.now() + 45000;
        const guard = () => {
          if (Date.now() >= deadline)
            throw new Error('Collection check timed out.');
        };
        const collection =
          kind === 'movie'
            ? await new TheMovieDb().getCollection({
                collectionId: Number(collectionId),
              })
            : await getCuratedCollection(kind, String(collectionId));
        const ids = [
          ...new Set(collection.parts.map((part) => String(part.id))),
        ];
        if (
          options.selectedIds &&
          (!pushLibraries ||
            !options.selectedIds.length ||
            options.selectedIds.length > 500 ||
            options.selectedIds.some((id) => !ids.includes(id)))
        )
          throw new Error('Select valid collection members.');
        if (ids.length > 500 || ids.length * server.libraries.length > 2500)
          throw new Error('Collection exceeds the safe lookup limit.');
        const selected =
          pushLibraries ?? removals?.map((item) => item.libraryId);
        if (
          selected &&
          (!selected.length ||
            selected.some(
              (id) => !server.targets.some((target) => target.id === id)
            ))
        ) {
          throw new Error('Select an enabled library for this media type.');
        }
        const repository = getRepository(CollectionLink);
        const links = await repository.find({
          where:
            kind === 'movie'
              ? {
                  collectionId: storedCollectionId,
                  serverId: server.serverId,
                  sourceType: kind,
                }
              : {
                  sourceId: String(collectionId),
                  sourceType: kind,
                  serverId: server.serverId,
                },
        });
        const scanner = new CollectionAvailabilityScanner();
        const found = new Map<
          string,
          (CollectionMovie & { sourceId: string })[]
        >();
        const failed = new Set<string>();
        await mapWithConcurrency(
          server.libraries.flatMap((library) =>
            ids.map((id) => ({ library, id }))
          ),
          4,
          async ({ library, id }) => {
            const target = server.targetForLibrary(library.id);
            try {
              guard();
              const lookupKey =
                scope + ':' + kind + ':' + library.id + ':' + id;
              const saved = lookups.get(lookupKey);
              let items =
                saved && saved.expires > Date.now() ? saved.value : undefined;
              if (!items) {
                items =
                  kind === 'movie'
                    ? await server.findMovies(library.id, Number(id))
                    : await server.findMember!(
                        library.id,
                        id,
                        collection.parts.find((part) => String(part.id) === id)
                          ?.title ?? ''
                      );
                const qualities = new Set(
                  items.flatMap((item) => item.qualities)
                );
                if (server.refreshMember) {
                  const refresh = server.refreshMember;
                  for (const item of items) {
                    refreshes.set(lookupKey, () => refresh(item.id));
                  }
                }
                const complete =
                  kind !== 'movie'
                    ? items.length > 0
                    : qualities.has(false) &&
                      (qualities.has(true) ||
                        !settings.radarr.some((service) => service.is4k));
                if (lookups.size >= 10000)
                  lookups.delete(lookups.keys().next().value!);
                lookups.set(lookupKey, {
                  value: items,
                  expires: Date.now() + (complete ? 300000 : 60000),
                });
              }
              if (kind === 'movie')
                for (const item of items) {
                  await scanner.accept(Number(id), item);
                }
              found.set(target, [
                ...(found.get(target) ?? []),
                ...items.map((item) => ({ ...item, sourceId: id })),
              ]);
            } catch {
              failed.add(target);
            }
          }
        );
        const inspected = await mapWithConcurrency(
          server.targets,
          3,
          async (target) => {
            const link = links.find((entry) => entry.libraryId === target.id);
            const items = found.get(target.id) ?? [];
            const destination: CollectionSyncStatus['destinations'][number] = {
              libraryId: target.id,
              libraryName: target.name,
              count: new Set(items.map((item) => item.id)).size,
              availableIds: [...new Set(items.map((item) => item.sourceId))],
              state: 'unknown',
              managed: !!link?.enabled,
            };
            let remote = null as Awaited<ReturnType<typeof server.get>>;
            try {
              guard();
              if (failed.has(target.id))
                throw new Error('Library lookup failed.');
              remote = link?.remoteId ? await server.get(link.remoteId) : null;
              if (
                remote &&
                (remote.id !== link?.remoteId || remote.libraryId !== target.id)
              )
                throw new Error('Collection identity changed.');
              if (!remote) {
                const matches = await server.find(
                  target.id,
                  link?.state === 'pending' ? link.title : collection.name
                );
                if (matches.length > 1 || matches.some((match) => match.smart))
                  destination.state = 'conflict';
                else {
                  remote = matches[0] ?? null;
                  destination.state = remote ? 'exists' : 'missing';
                }
                if (link?.remoteId) {
                  link.enabled = false;
                  link.state = 'deleted';
                  await repository.save(link);
                  destination.managed = false;
                } else if (link?.state === 'pending') {
                  if (remote) {
                    link.remoteId = remote.id;
                    link.enabled = true;
                    link.state = 'active';
                    await repository.save(link);
                    destination.managed = true;
                  } else if (destination.state === 'missing') {
                    // Creation could have reached the server before a timeout. Never blindly retry.
                    destination.state = 'unknown';
                  }
                }
              } else {
                destination.state = remote.smart ? 'conflict' : 'exists';
              }
              if (remote && destination.state === 'exists') {
                destination.removalToken = digest([
                  scope,
                  collectionId,
                  target.id,
                  remote.id,
                ]);
              }
            } catch {
              destination.state = 'unknown';
            }
            return { target, link, items, remote, destination };
          }
        );
        if (
          selected &&
          inspected.some(
            ({ destination }) =>
              selected.includes(destination.libraryId) &&
              (destination.state === 'unknown' ||
                destination.state === 'conflict')
          )
        )
          throw new Error('Cannot verify the selected collections.');
        if (
          removals?.some(
            (removal) =>
              !inspected.some(
                ({ destination }) =>
                  destination.libraryId === removal.libraryId &&
                  destination.state === 'exists' &&
                  destination.removalToken === removal.removalToken
              )
          )
        ) {
          throw new Error(
            'Collection changed since confirmation. Check again before removing it.'
          );
        }
        const value: CollectionSyncStatus = {
          supported: true,
          checkedAt: Date.now(),
          destinations: [],
        };
        for (const entry of inspected) {
          const { target, items, destination, remote } = entry;
          let link = entry.link;
          const creating =
            pushLibraries?.includes(target.id) &&
            destination.state === 'missing';
          const keys = [
            ...new Set(
              items
                .filter((item) =>
                  creating
                    ? !options.selectedIds ||
                      options.selectedIds.includes(item.sourceId)
                    : !link?.seenIds?.includes(item.sourceId)
                )
                .map((item) => item.id)
            ),
          ];
          try {
            if (
              removals?.some((removal) => removal.libraryId === target.id) &&
              remote
            ) {
              guard();
              // Save the stop before DELETE; a timeout must never resume automatic updates.
              link =
                link ??
                new CollectionLink({
                  id: collectionLinkId(
                    server.serverId,
                    collectionId,
                    target.id,
                    kind
                  ),
                  collectionId: storedCollectionId,
                  sourceType: kind,
                  sourceId: String(collectionId),
                  serverId: server.serverId,
                  libraryId: target.id,
                  title: remote.title,
                  remoteId: remote.id,
                });
              link.enabled = false;
              link.state = 'removing';
              await repository.save(link);
              destination.managed = false;
              await server.remove(remote.id, target.id);
              link.state = 'deleted';
              await repository.save(link);
              destination.state = 'missing';
              delete destination.removalToken;
            } else {
              if (
                pushLibraries?.includes(target.id) &&
                destination.state === 'missing' &&
                keys.length
              ) {
                guard();
                link = new CollectionLink({
                  id: collectionLinkId(
                    server.serverId,
                    collectionId,
                    target.id,
                    kind
                  ),
                  collectionId: storedCollectionId,
                  sourceType: kind,
                  sourceId: String(collectionId),
                  seenIds: [...new Set(items.map((item) => item.sourceId))],
                  serverId: server.serverId,
                  libraryId: target.id,
                  title: collection.name,
                  remoteId: null,
                  enabled: false,
                  state: 'pending',
                });
                await repository.save(link);
                const created = await server.create(
                  target.id,
                  collection.name,
                  keys
                );
                if (created.libraryId !== target.id || created.smart)
                  throw new Error('Unexpected created collection.');
                link.remoteId = created.id;
                link.enabled = true;
                link.state = 'active';
                await repository.save(link);
                destination.state = 'exists';
                destination.managed = true;
                destination.removalToken = digest([
                  scope,
                  collectionId,
                  target.id,
                  created.id,
                ]);
              }
              if (
                link?.enabled &&
                link.remoteId &&
                destination.state === 'exists' &&
                keys.length
              ) {
                guard();
                await server.add(link.remoteId, keys);
                link.seenIds = [
                  ...new Set([
                    ...(link.seenIds ?? []),
                    ...items.map((item) => item.sourceId),
                  ]),
                ];
                await repository.save(link);
              }
            }
          } catch {
            destination.state = 'unknown';
            delete destination.removalToken;
          }
          value.destinations.push(destination);
        }
        if (results.size >= 256) results.delete(results.keys().next().value!);
        results.set(key, { expires: Date.now() + 55000, value });
        return value;
      })
    )
  );
  // Normal scanners acquire their own owner/configuration guards. Run them
  // only after releasing the collection guards: reacquiring those non-reentrant
  // locks inside the collection check would also block the owner's sign-in.
  await mapWithConcurrency([...refreshes], 4, async ([lookupKey, refresh]) => {
    try {
      await refresh();
    } catch (error) {
      lookups.delete(lookupKey);
      results.delete(key);
      throw error;
    }
  });
  return result;
};

/** Normal media-server scans maintain memberships while collection pages are closed. */
export const syncManagedCollections = async (): Promise<void> => {
  const serverId = configuredCollectionServerId();
  if (!serverId) return;
  const links = await getRepository(CollectionLink).find({
    where: [
      { serverId, enabled: true },
      { serverId, state: 'pending' },
    ],
  });
  const sources = new Map(
    links.map((link) => [
      `${link.sourceType}:${link.sourceId ?? link.collectionId}`,
      link,
    ])
  );
  for (const link of sources.values()) {
    const id = link.sourceId ?? link.collectionId;
    try {
      await checkCollection(id, undefined, undefined, {
        kind: link.sourceType,
      });
    } catch {
      logger.warn(
        'Unable to update a managed collection; will retry next scan.',
        { label: 'Collection Sync', collectionId: id }
      );
    }
  }
};

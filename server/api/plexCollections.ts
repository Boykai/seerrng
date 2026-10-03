import { PlexSavedItemAPI } from '@server/api/mediaServerSavedItem';
import PlexAPI from '@server/api/plexapi';
import { MediaServerType } from '@server/constants/server';
import { getSettings } from '@server/lib/settings';
import type {
  MediaServerCollectionContext,
  MediaServerCollectionsStatus,
} from '@server/models/MediaServerCollections';
import { mapWithConcurrency } from '@server/utils/concurrency';

const PAGE_SIZE = 100;
const MAX_COLLECTIONS = 500;
const MAX_MEMBERS = 10_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,20}$/.test(value);
const pageNumber = (value: unknown): number | undefined =>
  (typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : undefined;

class CollectionLimitError extends Error {}
export class PlexCollectionAuthorityError extends Error {}

const metadataPage = (
  value: unknown,
  offset: number,
  maximum: number
): { items: unknown[]; complete: boolean } => {
  const container =
    isRecord(value) && isRecord(value.MediaContainer)
      ? value.MediaContainer
      : undefined;
  if (!container) throw new Error('Invalid Plex collection page.');
  const items = Array.isArray(container.Metadata)
    ? container.Metadata
    : container.Metadata === undefined && pageNumber(container.size) === 0
      ? []
      : undefined;
  if (!items || items.length > PAGE_SIZE)
    throw new Error('Invalid Plex collection page.');
  if (
    container.size !== undefined &&
    pageNumber(container.size) !== items.length
  )
    throw new Error('Invalid Plex page size.');
  if (container.offset !== undefined && pageNumber(container.offset) !== offset)
    throw new Error('Invalid Plex pagination offset.');
  const total = container.totalSize;
  if (offset + items.length > maximum) throw new CollectionLimitError();
  if (total !== undefined) {
    if (pageNumber(total) === undefined)
      throw new Error('Invalid Plex collection total.');
    if (Number(total) > maximum) throw new CollectionLimitError();
    if (
      offset + items.length > Number(total) ||
      (!items.length && offset < Number(total))
    )
      throw new Error('Incomplete Plex collection page.');
    return { items, complete: offset + items.length === Number(total) };
  }
  return { items, complete: items.length < PAGE_SIZE };
};

interface VerifiedSeries {
  id: string;
  libraryId: string;
  guid: string;
}
interface VerifiedCollection {
  id: string;
  name: string;
  guid: string;
}

/** Only current-account PMS owner authority is admitted; no owner-token fallback. */
export class PlexSeriesCollectionsAPI extends PlexAPI {
  private machineId?: string;
  constructor(private readonly context: MediaServerCollectionContext) {
    super({
      plexToken: context.user.plexToken,
      plexSettings: getSettings().plex,
    });
  }

  public async verifyOwner(): Promise<boolean> {
    const { user } = this.context;
    if (!user.plexId || !user.plexToken) return false;
    const account = new PlexSavedItemAPI(user.plexToken);
    await account.verifyAccount(user.plexId);
    const status = await this.getStatus();
    const machineIdentifier = status.MediaContainer.machineIdentifier;
    const configuredMachineId = getSettings().plex.machineId;
    if (
      !machineIdentifier ||
      (configuredMachineId && machineIdentifier !== configuredMachineId)
    )
      throw new PlexCollectionAuthorityError('Plex server identity changed.');
    const ownedServerIds = await account.getOwnedServerIds();
    const owned = ownedServerIds.includes(machineIdentifier);
    if (owned) this.machineId = machineIdentifier;
    return owned;
  }

  private async series(): Promise<VerifiedSeries> {
    if (!validId(this.context.itemId))
      throw new Error('Invalid Plex series item.');
    const { data } = await this.request<unknown>(
      'GET',
      `/library/metadata/${this.context.itemId}`,
      undefined,
      { params: { includeGuids: 1 } }
    );
    const container =
      isRecord(data) && isRecord(data.MediaContainer)
        ? data.MediaContainer
        : undefined;
    const item =
      Array.isArray(container?.Metadata) && container.Metadata.length === 1
        ? container.Metadata[0]
        : undefined;
    if (
      !isRecord(item) ||
      String(item.ratingKey) !== this.context.itemId ||
      item.type !== 'show' ||
      typeof item.guid !== 'string' ||
      !item.guid.length ||
      item.guid.length > 512 ||
      !Array.isArray(item.Guid) ||
      item.Guid.length > 100 ||
      !item.Guid.some(
        (guid) => isRecord(guid) && guid.id === `tmdb://${this.context.tmdbId}`
      ) ||
      !validId(String(item.librarySectionID))
    )
      throw new Error('Plex series identity could not be verified.');
    return {
      id: this.context.itemId,
      libraryId: String(item.librarySectionID),
      guid: String(item.guid),
    };
  }

  private collection(
    value: unknown,
    libraryId: string,
    {
      sectionScoped = false,
      allowOmittedSmart = false,
    }: { sectionScoped?: boolean; allowOmittedSmart?: boolean } = {}
  ): VerifiedCollection | undefined {
    const itemLibraryId =
      isRecord(value) && sectionScoped && value.librarySectionID === undefined
        ? libraryId
        : isRecord(value)
          ? value.librarySectionID
          : undefined;
    if (
      !isRecord(value) ||
      value.type !== 'collection' ||
      String(itemLibraryId) !== libraryId ||
      !validId(String(value.ratingKey)) ||
      typeof value.title !== 'string' ||
      !value.title.length ||
      value.title.length > 512 ||
      typeof value.guid !== 'string' ||
      !/^collection:\/\/[a-z\d-]{1,128}$/i.test(value.guid)
    )
      throw new Error('Invalid Plex collection identity.');
    if (
      value.smart !== false &&
      value.smart !== 0 &&
      value.smart !== '0' &&
      !(allowOmittedSmart && value.smart === undefined)
    )
      return undefined;
    if (value.subtype !== 'show') return undefined;
    return { id: String(value.ratingKey), name: value.title, guid: value.guid };
  }

  private async collections(libraryId: string): Promise<VerifiedCollection[]> {
    const collections: VerifiedCollection[] = [];
    const seen = new Set<string>();
    for (let offset = 0; offset <= MAX_COLLECTIONS; offset += PAGE_SIZE) {
      const { data } = await this.request<unknown>(
        'GET',
        `/library/sections/${libraryId}/collections`,
        undefined,
        {
          headers: {
            'X-Plex-Container-Start': String(offset),
            'X-Plex-Container-Size': String(PAGE_SIZE),
          },
        }
      );
      const page = metadataPage(data, offset, MAX_COLLECTIONS);
      for (const item of page.items) {
        const collection = this.collection(item, libraryId, {
          sectionScoped: true,
          allowOmittedSmart: true,
        });
        if (!collection) continue;
        if (seen.has(collection.id))
          throw new Error('Repeated Plex collection identity.');
        seen.add(collection.id);
        collections.push(collection);
      }
      if (page.complete) return collections;
    }
    throw new CollectionLimitError();
  }

  private async member(
    collectionId: string,
    series: VerifiedSeries
  ): Promise<boolean> {
    let found = false;
    const seen = new Set<string>();
    for (let offset = 0; offset <= MAX_MEMBERS; offset += PAGE_SIZE) {
      const { data } = await this.request<unknown>(
        'GET',
        `/library/collections/${collectionId}/children`,
        undefined,
        {
          headers: {
            'X-Plex-Container-Start': String(offset),
            'X-Plex-Container-Size': String(PAGE_SIZE),
          },
        }
      );
      const page = metadataPage(data, offset, MAX_MEMBERS);
      for (const item of page.items) {
        if (
          !isRecord(item) ||
          item.type !== 'show' ||
          !validId(String(item.ratingKey))
        )
          throw new Error('Invalid Plex collection member.');
        const key = String(item.ratingKey);
        if (seen.has(key)) throw new Error('Repeated Plex collection member.');
        seen.add(key);
        if (key === series.id) {
          if (item.guid !== series.guid)
            throw new Error('Plex collection member identity changed.');
          found = true;
        }
      }
      if (page.complete) return found;
    }
    throw new CollectionLimitError();
  }

  public async read(): Promise<MediaServerCollectionsStatus> {
    const base: MediaServerCollectionsStatus = {
      serverType: MediaServerType.PLEX,
      available: false,
      collections: [],
    };
    if (!this.context.user.plexId || !this.context.user.plexToken)
      return { ...base, reason: 'account-not-linked' };
    if (!validId(this.context.itemId))
      return { ...base, reason: 'series-not-found' };
    if (!(await this.verifyOwner()))
      return { ...base, reason: 'not-authorized' };
    try {
      const series = await this.series();
      const collections = await this.collections(series.libraryId);
      const options = await mapWithConcurrency(
        collections,
        5,
        async (collection) => ({
          id: collection.id,
          name: collection.name,
          member: await this.member(collection.id, series),
        })
      );
      return { ...base, available: true, collections: options };
    } catch (error) {
      if (error instanceof CollectionLimitError)
        return { ...base, reason: 'collection-limit' };
      throw error;
    }
  }

  public async setMembership(
    collectionId: string,
    desired: boolean
  ): Promise<MediaServerCollectionsStatus> {
    if (!validId(collectionId) || typeof desired !== 'boolean')
      throw new Error('Invalid Plex collection selection.');
    if (!(await this.verifyOwner()) || !this.machineId)
      throw new PlexCollectionAuthorityError(
        'Plex collection owner authority is required.'
      );
    const series = await this.series();
    const collections = await this.collections(series.libraryId);
    const selected = collections.find(
      (collection) => collection.id === collectionId
    );
    if (!selected)
      throw new PlexCollectionAuthorityError(
        'Choose an existing eligible collection in this Series library.'
      );
    const existing = await this.member(collectionId, series);
    if (existing !== desired) {
      // Recheck server-side collection identity immediately before mutation.
      const { data } = await this.request<unknown>(
        'GET',
        `/library/collections/${collectionId}`
      );
      const container =
        isRecord(data) && isRecord(data.MediaContainer)
          ? data.MediaContainer
          : undefined;
      const items = Array.isArray(container?.Metadata)
        ? container.Metadata
        : [];
      const current =
        items.length === 1
          ? this.collection(items[0], series.libraryId, {
              allowOmittedSmart: true,
            })
          : undefined;
      if (
        !current ||
        current.id !== selected.id ||
        current.guid !== selected.guid
      )
        throw new PlexCollectionAuthorityError(
          'Plex collection identity changed.'
        );
      if (desired) {
        await this.request(
          'PUT',
          `/library/collections/${collectionId}/items`,
          null,
          {
            params: {
              uri: `server://${encodeURIComponent(this.machineId)}/com.plexapp.plugins.library/library/metadata/${series.id}`,
            },
          }
        );
      } else {
        // The collection endpoint is the canonical PMS removal contract. Some
        // servers do not honor the documented /library/metadata alias here.
        await this.request(
          'DELETE',
          `/library/collections/${collectionId}/items/${series.id}`
        );
      }
      if ((await this.member(collectionId, series)) !== desired)
        throw new Error('Plex collection update was not confirmed.');
    }
    return this.read();
  }
}

export const getPlexSeriesCollections = (
  context: MediaServerCollectionContext
): Promise<MediaServerCollectionsStatus> =>
  new PlexSeriesCollectionsAPI(context).read();
export const setPlexSeriesCollectionMembership = (
  context: MediaServerCollectionContext,
  collectionId: string,
  member: boolean
): Promise<MediaServerCollectionsStatus> =>
  new PlexSeriesCollectionsAPI(context).setMembership(collectionId, member);

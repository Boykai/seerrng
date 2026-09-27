import JellyfinAPI, {
  sanitizeJellyfinLibraryItem,
  type JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import MusicBrainz from '@server/api/musicbrainz';

export interface JellyfinCollection {
  id: string;
  title: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
const items = (response: unknown): Record<string, unknown>[] => {
  if (
    !record(response) ||
    !Array.isArray(response.Items) ||
    !response.Items.every(record)
  ) {
    throw new Error('Unverified media-server response.');
  }
  return response.Items;
};
const collection = (item: Record<string, unknown>): JellyfinCollection => {
  if (
    item.Type !== 'BoxSet' ||
    !validId(item.Id) ||
    typeof item.Name !== 'string'
  ) {
    throw new Error('The selected item is not a collection.');
  }
  return { id: item.Id, title: item.Name };
};

/** Jellyfin and Emby share these collection endpoints. Never delete a movie ID. */
export default class JellyfinCollectionsAPI extends JellyfinAPI {
  public async findCollectionMembers(
    libraryId: string,
    sourceId: string,
    kind: 'tv' | 'music',
    title: string
  ): Promise<JellyfinLibraryItemExtended[]> {
    const response = await this.get<unknown>(
      '/Items',
      {
        params: {
          ParentId: libraryId,
          Recursive: true,
          IncludeItemTypes: kind === 'tv' ? 'Series' : 'MusicAlbum',
          ...(kind === 'tv'
            ? { AnyProviderIdEquals: `tmdb.${sourceId}` }
            : { SearchTerm: title }),
          Fields: 'ProviderIds,MediaSources,DateCreated',
          Limit: 100,
        },
        timeout: 8000,
      },
      0
    );
    const candidates = items(response);
    if (candidates.length >= 100)
      throw new Error('Collection lookup exceeded its limit.');
    const matches: JellyfinLibraryItemExtended[] = [];
    const musicbrainz = new MusicBrainz();
    for (const raw of candidates) {
      const item = sanitizeJellyfinLibraryItem(raw, true) as
        JellyfinLibraryItemExtended | undefined;
      if (
        !item ||
        !validId(item.Id) ||
        item.Type !== (kind === 'tv' ? 'Series' : 'MusicAlbum') ||
        item.LocationType === 'Virtual' ||
        item.LocationType === 'Offline'
      )
        continue;
      const providers = raw.ProviderIds;
      if (!record(providers)) continue;
      const directId =
        kind === 'tv'
          ? (providers.Tmdb ?? providers.TheMovieDb)
          : providers.MusicBrainzReleaseGroup;
      if (directId === sourceId) matches.push(item);
      else if (
        kind === 'music' &&
        typeof providers.MusicBrainzAlbum === 'string' &&
        (providers.MusicBrainzAlbum === sourceId ||
          (await musicbrainz.collectionReleaseGroup(
            providers.MusicBrainzAlbum
          )) === sourceId)
      )
        matches.push(item);
    }
    return matches;
  }
  public async findCollectionMovies(
    libraryId: string,
    tmdbId: number
  ): Promise<JellyfinLibraryItemExtended[]> {
    const response = await this.get<unknown>(
      '/Items',
      {
        params: {
          ParentId: libraryId,
          Recursive: true,
          IncludeItemTypes: 'Movie',
          AnyProviderIdEquals: `tmdb.${tmdbId}`,
          CollapseBoxSetItems: false,
          Fields: 'ProviderIds,MediaSources,Width,Height,DateCreated',
          Limit: 100,
        },
        timeout: 8000,
      },
      0
    );
    const matches = items(response);
    if (matches.length >= 100)
      throw new Error('Movie lookup exceeded its limit.');
    return matches.flatMap((item) => {
      const movie = sanitizeJellyfinLibraryItem(item, true) as
        JellyfinLibraryItemExtended | undefined;
      return movie?.Type === 'Movie' &&
        validId(movie.Id) &&
        String(movie.ProviderIds.Tmdb ?? movie.ProviderIds.TheMovieDb) ===
          String(tmdbId) &&
        movie.LocationType !== 'Virtual' &&
        movie.LocationType !== 'Offline'
        ? [movie]
        : [];
    });
  }

  public async getCollection(id: string): Promise<JellyfinCollection | null> {
    if (!validId(id)) throw new Error('Invalid collection ID.');
    const response = await this.get<unknown>(
      '/Items',
      { params: { Ids: id }, timeout: 8000 },
      0
    );
    const matches = items(response);
    if (!matches.length) return null;
    if (matches.length !== 1 || matches[0].Id !== id)
      throw new Error('Unverified collection identity.');
    return collection(matches[0]);
  }

  public async findCollections(title: string): Promise<JellyfinCollection[]> {
    const matches: JellyfinCollection[] = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const response = await this.get<unknown>(
        '/Items',
        {
          params: {
            IncludeItemTypes: 'BoxSet',
            Recursive: true,
            StartIndex: offset,
            Limit: 100,
          },
          timeout: 8000,
        },
        0
      );
      const page = items(response).map(collection);
      matches.push(...page.filter((item) => item.title === title));
      if (page.length < 100) return matches;
    }
    throw new Error('Collection lookup exceeded its limit.');
  }

  public async createCollection(
    title: string,
    ids: string[]
  ): Promise<JellyfinCollection> {
    if (!ids.length || ids.some((id) => !validId(id)))
      throw new Error('Invalid collection members.');
    const response = await this.request<unknown>('POST', '/Collections', null, {
      params: { Name: title, Ids: ids.join(','), IsLocked: false },
      timeout: 8000,
    });
    if (!record(response.data) || !validId(response.data.Id))
      throw new Error('Unverified created collection.');
    const created = await this.getCollection(response.data.Id);
    if (!created) throw new Error('The new collection is not visible yet.');
    return created;
  }

  public async addCollectionItems(id: string, ids: string[]): Promise<void> {
    if (!(await this.getCollection(id)))
      throw new Error('Collection no longer exists.');
    const existing = new Set<string>();
    for (let offset = 0; offset < 10000; offset += 100) {
      const response = await this.get<unknown>(
        '/Items',
        {
          params: {
            ParentId: id,
            Recursive: false,
            StartIndex: offset,
            Limit: 100,
          },
          timeout: 8000,
        },
        0
      );
      const page = items(response);
      for (const item of page) {
        if (!validId(item.Id)) throw new Error('Invalid collection member.');
        existing.add(item.Id);
      }
      if (page.length < 100) break;
      if (offset === 9900)
        throw new Error('Collection membership exceeded its limit.');
    }
    const missing = [...new Set(ids)].filter((id) => !existing.has(id));
    if (missing.some((id) => !validId(id)))
      throw new Error('Invalid collection members.');
    for (let offset = 0; offset < missing.length; offset += 100) {
      await this.request(
        'POST',
        `/Collections/${encodeURIComponent(id)}/Items`,
        null,
        {
          params: { Ids: missing.slice(offset, offset + 100).join(',') },
          timeout: 8000,
        }
      );
    }
  }

  public async removeCollection(id: string): Promise<void> {
    // Guard the general Items endpoint with a fresh, strict BoxSet type check.
    // BoxSet members are links, not physical child movie files.
    if (!(await this.getCollection(id))) return;
    await this.request('DELETE', `/Items/${encodeURIComponent(id)}`, null, {
      timeout: 8000,
    });
    if (await this.getCollection(id))
      throw new Error('Collection removal was not confirmed.');
  }
}

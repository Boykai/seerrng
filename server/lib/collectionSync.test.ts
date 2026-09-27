import JellyfinCollectionsAPI from '@server/api/jellyfinCollections';
import PlexAPI from '@server/api/plexapi';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { CollectionLink } from '@server/entity/CollectionLink';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import {
  captureConfigurationAuthority,
  runWithConfigurationSnapshot,
} from '@server/lib/configurationAdmission';
import {
  captureMediaServerUserAuthority,
  runWithMediaServerUserAuthority,
} from '@server/lib/mediaServerUserAuthority';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as catalogs from './collectionCatalog';
import * as servers from './collectionServers';
import { checkCollection, collectionLinkId } from './collectionSync';

setupTestDb();
let sequence = 0;
const remote = {
  ratingKey: '900',
  title: 'Test Collection',
  librarySectionID: '1',
  smart: false,
};

beforeEach(() => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.replaceSection('plex', {
    ...settings.plex,
    machineId: `test-${++sequence}`,
    libraries: [
      { id: '1', name: 'Mixed Movies', type: 'movie', enabled: true },
      { id: '2', name: 'Animation', type: 'movie', enabled: true },
    ],
  });
  vi.spyOn(TheMovieDb.prototype, 'getCollection').mockResolvedValue({
    id: 55,
    name: 'Test Collection',
    parts: [{ id: 11 }, { id: 12 }],
  } as never);
  vi.spyOn(PlexAPI.prototype, 'findCollectionMovies').mockImplementation(
    async (libraryId, tmdbId) =>
      libraryId === '1' && tmdbId === 11
        ? [
            {
              ratingKey: '100',
              title: 'Movie',
              type: 'movie',
              guid: 'tmdb://11',
              Guid: [{ id: 'tmdb://11' }],
              Media: [],
              addedAt: 100,
              updatedAt: 100,
            },
          ]
        : []
  );
  vi.spyOn(PlexAPI.prototype, 'findCollections').mockResolvedValue([]);
  vi.spyOn(PlexAPI.prototype, 'getCollection').mockResolvedValue(remote);
  vi.spyOn(PlexAPI.prototype, 'createCollection').mockResolvedValue(remote);
  vi.spyOn(PlexAPI.prototype, 'addCollectionItems').mockResolvedValue();
  vi.spyOn(PlexAPI.prototype, 'removeCollection').mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

const link = (overrides: Partial<CollectionLink> = {}) =>
  getRepository(CollectionLink).save(
    new CollectionLink({
      id: collectionLinkId(getSettings().plex.machineId!, 55, '1'),
      collectionId: 55,
      serverId: getSettings().plex.machineId,
      libraryId: '1',
      title: 'Test Collection',
      remoteId: '900',
      enabled: true,
      state: 'active',
      ...overrides,
    })
  );

describe('Plex collection synchronization', () => {
  it('checks libraries independently and never creates on a page check', async () => {
    const result = await checkCollection(55);
    expect(
      result.destinations.map((item) => [
        item.libraryId,
        item.count,
        item.state,
      ])
    ).toEqual([
      ['1', 1, 'missing'],
      ['2', 0, 'missing'],
    ]);
    expect(PlexAPI.prototype.createCollection).not.toHaveBeenCalled();
    expect(result.destinations[0].availableIds).toEqual(['11']);
    expect(result.destinations[1].availableIds).toEqual([]);
  });
  it('creates only selected libraries containing available members and persists the link', async () => {
    const result = await checkCollection(55, ['1', '2']);
    expect(PlexAPI.prototype.createCollection).toHaveBeenCalledTimes(1);
    expect(PlexAPI.prototype.createCollection).toHaveBeenCalledWith(
      'Test Collection',
      '1',
      ['100'],
      getSettings().plex.machineId,
      'movie'
    );
    expect(result.destinations[0].managed).toBe(true);
    expect((await getRepository(CollectionLink).find())[0].remoteId).toBe(
      '900'
    );
  });
  it('serializes repeated clicks and prevents duplicate creation', async () => {
    await Promise.all([checkCollection(55, ['1']), checkCollection(55, ['1'])]);
    expect(PlexAPI.prototype.createCollection).toHaveBeenCalledTimes(1);
  });
  it('shares page checks within the one-minute interval', async () => {
    await Promise.all([checkCollection(55), checkCollection(55)]);
    expect(PlexAPI.prototype.findCollectionMovies).toHaveBeenCalledTimes(4);
  });
  it('never adopts or alters an unrelated existing collection', async () => {
    vi.mocked(PlexAPI.prototype.findCollections).mockResolvedValue([remote]);
    await checkCollection(55, ['1']);
    expect(PlexAPI.prototype.createCollection).not.toHaveBeenCalled();
    expect(PlexAPI.prototype.addCollectionItems).not.toHaveBeenCalled();
    expect(await getRepository(CollectionLink).count()).toBe(0);
  });
  it('stops synchronization after a confirmed Plex deletion without recreation', async () => {
    await link();
    vi.mocked(PlexAPI.prototype.getCollection).mockResolvedValue(null);
    const result = await checkCollection(55);
    expect(result.destinations[0].state).toBe('missing');
    expect((await getRepository(CollectionLink).find())[0].enabled).toBe(false);
    expect(PlexAPI.prototype.createCollection).not.toHaveBeenCalled();
  });
  it('keeps the saved link on outages and does not authorize creating a duplicate', async () => {
    await link();
    vi.mocked(PlexAPI.prototype.getCollection).mockRejectedValue(
      new Error('offline')
    );
    expect((await checkCollection(55)).destinations[0].state).toBe('unknown');
    expect((await getRepository(CollectionLink).find())[0].enabled).toBe(true);
    await expect(checkCollection(55, ['1'])).rejects.toThrow('Cannot verify');
    expect(PlexAPI.prototype.createCollection).not.toHaveBeenCalled();
  });
  it('updates a renamed linked collection by ID, without replacing its name', async () => {
    await link();
    vi.mocked(PlexAPI.prototype.getCollection).mockResolvedValue({
      ...remote,
      title: 'My custom title',
    });
    await checkCollection(55);
    expect(PlexAPI.prototype.addCollectionItems).toHaveBeenCalledWith(
      '900',
      ['100'],
      getSettings().plex.machineId
    );
    expect(PlexAPI.prototype.createCollection).not.toHaveBeenCalled();
  });
  it('recovers a timed-out creation only when a matching saved intent exists', async () => {
    await link({ remoteId: null, enabled: false, state: 'pending' });
    vi.mocked(PlexAPI.prototype.findCollections).mockResolvedValue([remote]);
    expect((await checkCollection(55)).destinations[0].managed).toBe(true);
    expect(PlexAPI.prototype.createCollection).not.toHaveBeenCalled();
  });
  it('blocks writes when even one selected destination could not be checked', async () => {
    vi.mocked(PlexAPI.prototype.findCollections).mockImplementation(
      async (id) => {
        if (id === '2') throw new Error('offline');
        return [];
      }
    );
    await expect(checkCollection(55, ['1', '2'])).rejects.toThrow(
      'Cannot verify'
    );
    expect(PlexAPI.prototype.createCollection).not.toHaveBeenCalled();
  });
  it('rejects disabled, unknown and non-movie target libraries', async () => {
    await expect(checkCollection(55, ['99'])).rejects.toThrow(
      'enabled library for this media type'
    );
  });
  it('updates both HD and 4K availability using the normal scanner', async () => {
    vi.mocked(PlexAPI.prototype.findCollectionMovies).mockResolvedValue([
      {
        ratingKey: '100',
        title: 'Movie',
        type: 'movie',
        guid: 'tmdb://11',
        Guid: [{ id: 'tmdb://11' }],
        Media: [{ videoResolution: '1080' }, { videoResolution: '4k' }],
        addedAt: 100,
        updatedAt: 100,
      },
    ] as never);
    await checkCollection(55);
    const media = await getRepository(Media).findOneByOrFail({ tmdbId: 11 });
    expect([media.status, media.status4k]).toEqual([
      MediaStatus.AVAILABLE,
      MediaStatus.AVAILABLE,
    ]);
    expect([media.ratingKey, media.ratingKey4k]).toEqual(['100', '100']);
  });
  it('removes only the confirmed remote collection and disables its sync', async () => {
    await link();
    const before = await checkCollection(55);
    const removalToken = before.destinations[0].removalToken!;
    const result = await checkCollection(55, undefined, [
      { libraryId: '1', removalToken },
    ]);
    expect(PlexAPI.prototype.removeCollection).toHaveBeenCalledWith('900', '1');
    expect(result.destinations[0].state).toBe('missing');
    const saved = (await getRepository(CollectionLink).find())[0];
    expect([saved.enabled, saved.state]).toEqual([false, 'deleted']);
  });
  it('rejects stale removal confirmation when the remote identity changes', async () => {
    vi.mocked(PlexAPI.prototype.findCollections).mockResolvedValue([remote]);
    const before = await checkCollection(55);
    vi.mocked(PlexAPI.prototype.findCollections).mockResolvedValue([
      { ...remote, ratingKey: '901' },
    ]);
    await expect(
      checkCollection(55, undefined, [
        { libraryId: '1', removalToken: before.destinations[0].removalToken! },
      ])
    ).rejects.toThrow('changed since confirmation');
    expect(PlexAPI.prototype.removeCollection).not.toHaveBeenCalled();
  });
  it('stops sync even if removal times out', async () => {
    await link();
    const before = await checkCollection(55);
    vi.mocked(PlexAPI.prototype.removeCollection).mockRejectedValue(
      new Error('timeout')
    );
    const result = await checkCollection(55, undefined, [
      { libraryId: '1', removalToken: before.destinations[0].removalToken! },
    ]);
    expect(result.destinations[0].state).toBe('unknown');
    expect((await getRepository(CollectionLink).find())[0].enabled).toBe(false);
  });
  it('does not blindly retry a creation whose response was lost', async () => {
    vi.mocked(PlexAPI.prototype.createCollection).mockRejectedValue(
      new Error('timeout')
    );
    expect((await checkCollection(55, ['1'])).destinations[0].state).toBe(
      'unknown'
    );
    await expect(checkCollection(55, ['1'])).rejects.toThrow('Cannot verify');
    expect(PlexAPI.prototype.createCollection).toHaveBeenCalledTimes(1);
  });
  it('uses selection only at creation, then adds newly available unselected titles', async () => {
    const clock = vi.spyOn(Date, 'now');
    const start = Date.now();
    clock.mockReturnValue(start);
    await checkCollection(55, ['1'], undefined, { selectedIds: ['11'] });
    expect((await getRepository(CollectionLink).find())[0].seenIds).toEqual([
      '11',
    ]);
    vi.mocked(PlexAPI.prototype.addCollectionItems).mockClear();
    const first = await PlexAPI.prototype.findCollectionMovies('1', 11);
    vi.mocked(PlexAPI.prototype.findCollectionMovies).mockImplementation(
      async (library, id) =>
        library === '1'
          ? [{ ...first[0], ratingKey: String(id === 11 ? 100 : 101) }]
          : []
    );
    clock.mockReturnValue(start + 600001);
    await checkCollection(55);
    expect(PlexAPI.prototype.addCollectionItems).toHaveBeenCalledWith(
      '900',
      ['101'],
      getSettings().plex.machineId
    );
    expect((await getRepository(CollectionLink).find())[0].seenIds).toEqual([
      '11',
      '12',
    ]);
  });
  it('does not restore previously added titles on later scans after a manual removal', async () => {
    await link({ seenIds: ['11'] });
    await checkCollection(55);
    expect(PlexAPI.prototype.addCollectionItems).not.toHaveBeenCalled();
  });
  it('does not add an already available title deliberately omitted at creation', async () => {
    const first = await PlexAPI.prototype.findCollectionMovies('1', 11);
    vi.mocked(PlexAPI.prototype.findCollectionMovies).mockImplementation(
      async (library, id) =>
        library === '1'
          ? [{ ...first[0], ratingKey: String(id === 11 ? 100 : 101) }]
          : []
    );
    await checkCollection(55, ['1'], undefined, { selectedIds: ['11'] });
    expect(PlexAPI.prototype.createCollection).toHaveBeenCalledWith(
      'Test Collection',
      '1',
      ['100'],
      getSettings().plex.machineId,
      'movie'
    );
    expect((await getRepository(CollectionLink).find())[0].seenIds).toEqual([
      '11',
      '12',
    ]);
    vi.mocked(PlexAPI.prototype.addCollectionItems).mockClear();
    await checkCollection(55, ['1'], undefined, { selectedIds: ['11', '12'] });
    expect(PlexAPI.prototype.addCollectionItems).not.toHaveBeenCalled();
  });
  it('adds newly discovered catalog members without keeping a selection allowlist', async () => {
    await link({ seenIds: ['11', '12'] });
    vi.mocked(TheMovieDb.prototype.getCollection).mockResolvedValue({
      id: 55,
      name: 'Test Collection',
      parts: [{ id: 11 }, { id: 12 }, { id: 13 }],
    } as never);
    const first = await PlexAPI.prototype.findCollectionMovies('1', 11);
    vi.mocked(PlexAPI.prototype.findCollectionMovies).mockImplementation(
      async (library, id) =>
        library === '1' && id === 13 ? [{ ...first[0], ratingKey: '103' }] : []
    );
    await checkCollection(55);
    expect(PlexAPI.prototype.addCollectionItems).toHaveBeenCalledWith(
      '900',
      ['103'],
      getSettings().plex.machineId
    );
  });
  it('allows a fresh selection after removing and recreating a collection', async () => {
    const first = await PlexAPI.prototype.findCollectionMovies('1', 11);
    vi.mocked(PlexAPI.prototype.findCollectionMovies).mockImplementation(
      async (library, id) =>
        library === '1'
          ? [{ ...first[0], ratingKey: String(id === 11 ? 100 : 101) }]
          : []
    );
    const before = await checkCollection(55, ['1'], undefined, {
      selectedIds: ['11'],
    });
    await checkCollection(55, undefined, [
      { libraryId: '1', removalToken: before.destinations[0].removalToken! },
    ]);
    vi.mocked(PlexAPI.prototype.getCollection).mockResolvedValue(null);
    vi.mocked(PlexAPI.prototype.createCollection).mockClear();
    await checkCollection(55, ['1'], undefined, { selectedIds: ['12'] });
    expect(PlexAPI.prototype.createCollection).toHaveBeenCalledWith(
      'Test Collection',
      '1',
      ['101'],
      getSettings().plex.machineId,
      'movie'
    );
  });
  it('does not remember a new item until its automatic addition succeeds', async () => {
    await link({ seenIds: ['12'] });
    vi.mocked(PlexAPI.prototype.addCollectionItems).mockRejectedValue(
      new Error('offline')
    );
    expect((await checkCollection(55)).destinations[0].state).toBe('unknown');
    expect((await getRepository(CollectionLink).find())[0].seenIds).toEqual([
      '12',
    ]);
  });
});

describe.each([MediaServerType.JELLYFIN, MediaServerType.EMBY])(
  'collection sync with media-server type %s',
  (type) => {
    beforeEach(async () => {
      const settings = getSettings();
      settings.main.mediaServerType = type;
      settings.replaceSection('jellyfin', {
        ...settings.jellyfin,
        serverId: `server-${sequence}`,
        apiKey: 'test',
        ip: 'localhost',
        port: 8096,
        libraries: [
          { id: 'a', name: 'Movies', type: 'movie', enabled: true },
          { id: 'b', name: 'Animation', type: 'movie', enabled: true },
        ],
      });
      await getRepository(User).update(1, {
        jellyfinUserId: 'owner',
        jellyfinDeviceId: 'device',
      });
      vi.spyOn(
        JellyfinCollectionsAPI.prototype,
        'findCollectionMovies'
      ).mockImplementation(async (library, id) =>
        id === 11
          ? ([
              {
                Id: library + '11',
                Name: 'Movie',
                Type: 'Movie',
                ProviderIds: { Tmdb: '11' },
                MediaSources: [],
              },
            ] as never)
          : []
      );
      vi.spyOn(
        JellyfinCollectionsAPI.prototype,
        'findCollections'
      ).mockResolvedValue([]);
      vi.spyOn(
        JellyfinCollectionsAPI.prototype,
        'getCollection'
      ).mockResolvedValue({ id: 'box1', title: 'Test Collection' });
      vi.spyOn(
        JellyfinCollectionsAPI.prototype,
        'createCollection'
      ).mockResolvedValue({ id: 'box1', title: 'Test Collection' });
      vi.spyOn(
        JellyfinCollectionsAPI.prototype,
        'addCollectionItems'
      ).mockResolvedValue();
      vi.spyOn(
        JellyfinCollectionsAPI.prototype,
        'removeCollection'
      ).mockResolvedValue();
    });
    it('combines enabled libraries in one server collection, then removes only that collection', async () => {
      const result = await checkCollection(55, ['server']);
      expect(result.destinations).toHaveLength(1);
      expect(
        JellyfinCollectionsAPI.prototype.createCollection
      ).toHaveBeenCalledWith('Test Collection', ['a11', 'b11']);
      expect(result.destinations[0].state).toBe('exists');
      await checkCollection(55, undefined, [
        {
          libraryId: 'server',
          removalToken: result.destinations[0].removalToken!,
        },
      ]);
      expect(
        JellyfinCollectionsAPI.prototype.removeCollection
      ).toHaveBeenCalledWith('box1');
      expect(PlexAPI.prototype.createCollection).not.toHaveBeenCalled();
    });
    it('does not create a partial collection when one library cannot be checked', async () => {
      vi.mocked(
        JellyfinCollectionsAPI.prototype.findCollectionMovies
      ).mockRejectedValue(new Error('offline'));
      await expect(checkCollection(55, ['server'])).rejects.toThrow(
        'Cannot verify'
      );
      expect(
        JellyfinCollectionsAPI.prototype.createCollection
      ).not.toHaveBeenCalled();
    });
  }
);

describe.each(['tv', 'music'] as const)(
  '%s automatic collection membership',
  (kind) => {
    it('adds later available members regardless of initial selection and does not reinsert seen members', async () => {
      const start = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
      const catalog = {
        id: '55',
        kind,
        name: 'Test Collection',
        overview: '',
        sourceUrl: '',
        parts: [
          { id: '11', title: 'First', releaseDate: '', genres: [] },
          { id: '12', title: 'Later', releaseDate: '', genres: [] },
        ],
      };
      vi.spyOn(catalogs, 'getCuratedCollection').mockResolvedValue(catalog);
      const target = { id: '1', name: 'Library' };
      let secondAvailable = false;
      const member = (id: string) => ({
        id: `remote-${id}`,
        title: 'Item',
        qualities: [],
      });
      const collection = {
        id: '900',
        title: 'Test Collection',
        libraryId: '1',
        smart: false,
      };
      const add = vi.fn().mockResolvedValue(undefined);
      const create = vi.fn().mockResolvedValue(collection);
      const refreshMember = vi.fn(async () => {
        const owner = await captureMediaServerUserAuthority(1, 'plex');
        await runWithMediaServerUserAuthority(owner, () =>
          runWithConfigurationSnapshot(
            captureConfigurationAuthority('plex'),
            async () => undefined
          )
        );
      });
      vi.spyOn(servers, 'getCollectionServer').mockReturnValue({
        refreshMember,
        serverId: getSettings().plex.machineId!,
        libraries: [target],
        targets: [target],
        targetForLibrary: () => '1',
        findMovies: vi.fn(),
        findMember: async (_library, id) =>
          id === '11' || secondAvailable ? [member(id)] : [],
        get: async () => collection,
        find: async () => [],
        create,
        add,
        remove: vi.fn(),
      });
      await checkCollection('55', ['1'], undefined, {
        kind,
        selectedIds: ['11'],
      });
      expect(create).toHaveBeenCalledWith('1', 'Test Collection', [
        'remote-11',
      ]);
      expect(refreshMember).toHaveBeenCalled();
      add.mockClear();
      secondAvailable = true;
      clock.mockReturnValue(start + 600001);
      await checkCollection('55', undefined, undefined, { kind });
      expect(add).toHaveBeenCalledWith('900', ['remote-12']);
      add.mockClear();
      clock.mockReturnValue(start + 1200002);
      await checkCollection('55', undefined, undefined, { kind });
      expect(add).not.toHaveBeenCalled();
      expect((await getRepository(CollectionLink).find())[0]).toMatchObject({
        sourceType: kind,
        seenIds: ['11', '12'],
      });
    });
  }
);

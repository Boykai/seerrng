import { getRepository } from '@server/datasource';
import DiscoveryCuratedIdentityMapping from '@server/entity/DiscoveryCuratedIdentityMapping';
import DiscoveryCuratedIdentityPack from '@server/entity/DiscoveryCuratedIdentityPack';
import DiscoveryIdentityMapping from '@server/entity/DiscoveryIdentityMapping';
import { User } from '@server/entity/User';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  applyCuratedIdentityMappings,
  exportCuratedIdentityPack,
  importCuratedIdentityMappingPack,
  listCuratedIdentityPacks,
  parseCuratedIdentityMappingPack,
  removeCuratedIdentityPack,
} from './curatedIdentityPacks';
import {
  applyPersonalIdentityMappings,
  exportPersonalIdentityMappingPack,
  importPersonalIdentityMappingPack,
  parsePersonalIdentityMappingPack,
  parsePersonalIdentitySource,
  removePersonalIdentityMapping,
  savePersonalIdentityMapping,
} from './identityMappings';
import type { PersonalLibraryItem } from './library';

setupTestDb();

it('keeps manual identity matches private to the owner and resettable', async () => {
  const owner = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });
  const item: PersonalLibraryItem = {
    id: 'simkl:anime:123',
    source: 'simkl',
    sourceId: '123',
    title: 'Example anime',
  };

  await savePersonalIdentityMapping(owner.id, item.id, 456, 'tv');

  assert.deepEqual(await applyPersonalIdentityMappings(owner.id, [item]), [
    {
      ...item,
      tmdbId: 456,
      mediaType: 'tv',
      identityMapped: true,
      identityResolution: 'personal',
    },
  ]);
  assert.deepEqual(
    await applyPersonalIdentityMappings(owner.id + 10_000, [item]),
    [item]
  );
  assert.equal(
    (await getRepository(DiscoveryIdentityMapping).find()).length,
    1
  );
  assert.deepEqual(await removePersonalIdentityMapping(owner.id, item.id), {
    removed: true,
  });
  assert.deepEqual(await applyPersonalIdentityMappings(owner.id, [item]), [
    item,
  ]);
});

it('validates the source-specific library identity before saving a match', async () => {
  assert.equal(parsePersonalIdentitySource('plex:movie:12'), 'plex');
  assert.equal(
    parsePersonalIdentitySource('trakt:tv:the-expanse-season-1'),
    'trakt'
  );
  assert.equal(
    parsePersonalIdentitySource('mdblist:unknown:tt1234567'),
    'mdblist'
  );
  assert.equal(
    parsePersonalIdentitySource(
      'jellyfin:tv:00112233-4455-6677-8899-aabbccddeeff'
    ),
    'jellyfin'
  );
  assert.equal(parsePersonalIdentitySource('anilist:123'), 'anilist');
  assert.throws(() => parsePersonalIdentitySource('trakt:other:12'));
  assert.throws(() => parsePersonalIdentitySource('simkl:anime:12:extra'));
  await assert.rejects(
    () =>
      savePersonalIdentityMapping(1, 'trakt:movie:12', 1_000_000_001, 'movie'),
    /valid catalog match/i
  );
});

it('exports and imports a versioned personal mapping pack idempotently', async () => {
  const owner = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });
  await savePersonalIdentityMapping(owner.id, 'trakt:movie:123', 456, 'movie');
  await savePersonalIdentityMapping(owner.id, 'anilist:101', 202, 'tv');

  const exported = await exportPersonalIdentityMappingPack(owner.id);
  assert.equal(exported.format, 'seerrng.personal-title-matches');
  assert.equal(exported.version, 1);
  assert.equal(exported.entries.length, 2);
  assert.deepEqual(Object.keys(exported.entries[0]).sort(), [
    'identity',
    'mediaType',
    'tmdbId',
  ]);

  const updated = await importPersonalIdentityMappingPack(owner.id, {
    ...exported,
    entries: [
      { ...exported.entries[0], tmdbId: 789 },
      exported.entries[1],
      {
        identity: 'mdblist:unknown:tt1234567',
        tmdbId: 321,
        mediaType: 'movie',
      },
    ],
  });
  assert.deepEqual(updated, {
    imported: 1,
    updated: 1,
    unchanged: 1,
    total: 3,
  });

  const repeated = await importPersonalIdentityMappingPack(owner.id, {
    ...exported,
    entries: [
      { ...exported.entries[0], tmdbId: 789 },
      exported.entries[1],
      {
        identity: 'mdblist:unknown:tt1234567',
        tmdbId: 321,
        mediaType: 'movie',
      },
    ],
  });
  assert.deepEqual(repeated, {
    imported: 0,
    updated: 0,
    unchanged: 3,
    total: 3,
  });
});

it('rejects unsupported, duplicated, and malformed title-match pack entries', async () => {
  const exportedAt = new Date().toISOString();
  assert.throws(
    () =>
      parsePersonalIdentityMappingPack({
        format: 'other-app',
        version: 1,
        exportedAt,
        entries: [],
      }),
    /supported SeerrNG pack/
  );
  assert.throws(
    () =>
      parsePersonalIdentityMappingPack({
        format: 'seerrng.personal-title-matches',
        version: 1,
        exportedAt,
        entries: [
          { identity: 'anilist:101', tmdbId: 202, mediaType: 'tv' },
          { identity: 'anilist:101', tmdbId: 203, mediaType: 'tv' },
        ],
      }),
    /repeats a provider identity/
  );
  assert.throws(
    () =>
      parsePersonalIdentityMappingPack({
        format: 'seerrng.personal-title-matches',
        version: 1,
        exportedAt,
        entries: [{ identity: 'untrusted:1', tmdbId: 202, mediaType: 'tv' }],
      }),
    /valid library title/
  );
});

it('applies administrator-curated matches across users below private matches', async () => {
  const owner = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });
  const identity = 'anilist:900001';
  const item: PersonalLibraryItem = {
    id: identity,
    source: 'anilist',
    sourceId: '900001',
    title: 'Shared anime title',
  };
  const exportedAt = new Date().toISOString();

  await importCuratedIdentityMappingPack({
    format: 'seerrng.curated-title-matches',
    version: 1,
    packId: 'anime-core',
    name: 'Anime core',
    exportedAt,
    entries: [{ identity, tmdbId: 456, mediaType: 'tv' }],
  });

  assert.deepEqual(await applyCuratedIdentityMappings([item]), [
    {
      ...item,
      tmdbId: 456,
      mediaType: 'tv',
      identityResolution: 'curated',
    },
  ]);
  await savePersonalIdentityMapping(owner.id, identity, 789, 'movie');
  const privateMatch = await applyPersonalIdentityMappings(owner.id, [item]);
  assert.deepEqual(await applyCuratedIdentityMappings(privateMatch), [
    {
      ...item,
      tmdbId: 789,
      mediaType: 'movie',
      identityMapped: true,
      identityResolution: 'personal',
    },
  ]);

  const packs = await listCuratedIdentityPacks();
  assert.deepEqual(packs, [
    {
      packId: 'anime-core',
      name: 'Anime core',
      version: 1,
      count: 1,
      updatedAt: packs[0].updatedAt,
    },
  ]);
  const exported = await exportCuratedIdentityPack('anime-core');
  assert.equal(exported.entries[0].tmdbId, 456);
  assert.equal(exported.entries[0].identity, identity);
});

it('replaces curated packs atomically and rejects identities owned by another pack', async () => {
  const exportedAt = new Date().toISOString();
  const firstEntry = {
    identity: 'anilist:900002',
    tmdbId: 901,
    mediaType: 'tv' as const,
  };
  await importCuratedIdentityMappingPack({
    format: 'seerrng.curated-title-matches',
    version: 1,
    packId: 'anime-extra',
    name: 'Anime extra',
    exportedAt,
    entries: [
      firstEntry,
      {
        identity: 'trakt:movie:900002',
        tmdbId: 902,
        mediaType: 'movie',
      },
    ],
  });
  const replacement = await importCuratedIdentityMappingPack({
    format: 'seerrng.curated-title-matches',
    version: 1,
    packId: 'anime-extra',
    name: 'Anime extra',
    exportedAt,
    entries: [{ ...firstEntry, tmdbId: 903 }],
  });
  assert.deepEqual(replacement, {
    packId: 'anime-extra',
    name: 'Anime extra',
    imported: 0,
    updated: 1,
    unchanged: 0,
    removed: 1,
    total: 1,
  });

  await assert.rejects(
    () =>
      importCuratedIdentityMappingPack({
        format: 'seerrng.curated-title-matches',
        version: 1,
        packId: 'anime-conflict',
        name: 'Conflicting pack',
        exportedAt,
        entries: [{ ...firstEntry, tmdbId: 904 }],
      }),
    /already assigned to shared pack "anime-extra"/
  );
  assert.equal(
    (
      await getRepository(DiscoveryCuratedIdentityMapping).findOneByOrFail({
        identity: firstEntry.identity,
      })
    ).tmdbId,
    903
  );
  assert.equal(
    await getRepository(DiscoveryCuratedIdentityPack).countBy({
      packId: 'anime-conflict',
    }),
    0
  );
});

it('validates curated pack metadata and never accepts extra credential fields', async () => {
  const base = {
    format: 'seerrng.curated-title-matches',
    version: 1,
    packId: 'safe-pack',
    name: 'Safe pack',
    exportedAt: new Date().toISOString(),
    entries: [],
  };
  assert.equal(parseCuratedIdentityMappingPack(base).packId, 'safe-pack');
  assert.throws(
    () => parseCuratedIdentityMappingPack({ ...base, apiKey: 'secret-value' }),
    /file is invalid/
  );
  assert.throws(
    () =>
      parseCuratedIdentityMappingPack({
        ...base,
        packId: '../unsafe',
      }),
    /valid shared pack ID/
  );
  assert.throws(
    () =>
      parseCuratedIdentityMappingPack({
        ...base,
        entries: [
          { identity: 'anilist:9', tmdbId: 1, mediaType: 'movie' },
          { identity: 'anilist:9', tmdbId: 2, mediaType: 'movie' },
        ],
      }),
    /repeats a provider identity/
  );

  await importCuratedIdentityMappingPack({
    ...base,
    packId: 'empty-test-pack',
  });
  assert.deepEqual(await removeCuratedIdentityPack('empty-test-pack'), {
    removed: true,
  });
  assert.deepEqual(
    await applyCuratedIdentityMappings([
      {
        id: 'anilist:900001',
        tmdbId: undefined,
        mediaType: undefined,
      },
    ]),
    [
      {
        id: 'anilist:900001',
        tmdbId: undefined,
        mediaType: undefined,
      },
    ]
  );
});

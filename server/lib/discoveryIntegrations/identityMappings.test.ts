import { getRepository } from '@server/datasource';
import DiscoveryIdentityMapping from '@server/entity/DiscoveryIdentityMapping';
import { User } from '@server/entity/User';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  applyPersonalIdentityMappings,
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
    { ...item, tmdbId: 456, mediaType: 'tv', identityMapped: true },
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

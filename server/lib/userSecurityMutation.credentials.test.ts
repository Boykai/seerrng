import assert from 'node:assert/strict';
import { after, beforeEach, it } from 'node:test';

import dataSource, { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import {
  runUserSecurityMutationWithActor,
  runUserSecurityReadWithActor,
  UserMutationActorUnauthorizedError,
} from './userSecurityMutation';

// Real application entity/TypeORM selection, but only its disposable in-memory
// test database. No native provider, authentication endpoint or live config.
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(dataSource.options.type, 'better-sqlite3');
assert.equal(dataSource.options.database, ':memory:');
setupTestDb();
const nativeOptions = { includeMediaServerCredentials: true } as const;
const currentPair = {
  plexId: 222,
  plexToken: 'fixture-own-plex-token',
  jellyfinUserId: '0123456789abcdef0123456789abcdef',
  jellyfinAuthToken: 'fixture-own-native-token',
  jellyfinDeviceId: 'fixture-own-device',
};
beforeEach(async () => {
  await getRepository(User).update(1, {
    plexToken: 'fixture-owner-token-must-not-be-borrowed',
  });
  await getRepository(User).update(2, {
    ...currentPair,
    permissions: 0,
    passwordChangedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
});
after(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});

const ownActor = () =>
  runUserSecurityReadWithActor(2, 2, [], async (actor) => actor, nativeOptions);

it('ordinary repository and authority reads keep native credentials select:false', async () => {
  const repository = getRepository(User);
  for (const field of ['plexToken', 'jellyfinAuthToken', 'jellyfinDeviceId']) {
    assert.equal(
      repository.metadata.findColumnWithPropertyName(field)?.isSelect,
      false
    );
  }
  const actors = [
    await repository.findOneByOrFail({ id: 2 }),
    await runUserSecurityReadWithActor(2, 2, [], async (actor) => actor),
    await runUserSecurityMutationWithActor(2, 2, [], async (actor) => actor),
  ];
  for (const actor of actors) {
    assert.equal(actor.plexId, currentPair.plexId);
    assert.equal(actor.plexToken, undefined);
    assert.equal(actor.jellyfinAuthToken, undefined);
    assert.equal(actor.jellyfinDeviceId, undefined);
    assert.equal(actor.password, undefined);
    assert.equal(
      actor.passwordChangedAt?.getTime(),
      Date.parse('2026-10-01T00:00:00.000Z')
    );
  }
});

it('explicit native admission loads only fresh own-account credentials for read and mutation', async () => {
  for (const admit of [
    runUserSecurityReadWithActor,
    runUserSecurityMutationWithActor,
  ]) {
    const actor = await admit(2, 2, [], async (user) => user, nativeOptions);
    assert.equal(actor.id, 2);
    assert.equal(actor.permissions, 0);
    for (const [field, value] of Object.entries(currentPair)) {
      assert.equal(actor[field as keyof User], value);
    }
    assert.equal(actor.password, undefined);
    assert.equal(actor.resetPasswordGuid, undefined);
    assert.equal(actor.failedLoginAttempts, undefined);
    assert.equal(
      actor.passwordChangedAt?.getTime(),
      Date.parse('2026-10-01T00:00:00.000Z')
    );
  }
});

it('credential-bearing actors retain the unchanged filtered serialization boundary', async () => {
  const actor = await ownActor();
  for (const payload of [
    actor.filter(),
    actor.filter(true),
    JSON.parse(JSON.stringify(actor)),
  ]) {
    for (const field of [
      'plexToken',
      'jellyfinAuthToken',
      'jellyfinDeviceId',
      'password',
      'passwordChangedAt',
    ]) {
      assert.equal(Object.hasOwn(payload, field), false);
    }
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(currentPair.plexToken), false);
    assert.equal(serialized.includes(currentPair.jellyfinAuthToken), false);
    assert.equal(serialized.includes('fixture-owner-token'), false);
  }
});

it('native credential selection preserves current version and cross-user admission checks', async () => {
  for (const admit of [
    runUserSecurityReadWithActor,
    runUserSecurityMutationWithActor,
  ]) {
    let admitted = false;
    await assert.rejects(
      admit(
        2,
        2,
        [],
        async () => {
          admitted = true;
        },
        {
          ...nativeOptions,
          expectedCredentialVersion: Date.parse('2026-09-30T00:00:00.000Z'),
        }
      ),
      UserMutationActorUnauthorizedError
    );
    await assert.rejects(
      admit(
        2,
        1,
        Permission.ADMIN,
        async () => {
          admitted = true;
        },
        nativeOptions
      ),
      UserMutationActorUnauthorizedError
    );
    await assert.rejects(
      admit(
        999,
        999,
        [],
        async () => {
          admitted = true;
        },
        nativeOptions
      ),
      UserMutationActorUnauthorizedError
    );
    assert.equal(admitted, false);
  }
});

it('fresh native revalidation observes persisted rotation/unlink, never another account', async () => {
  const repository = getRepository(User);
  for (const field of [
    'plexToken',
    'jellyfinAuthToken',
    'plexId',
    'jellyfinUserId',
  ] as const) {
    await repository.update(2, currentPair);
    const snapshot = await ownActor();
    const changed =
      field === 'plexId'
        ? 333
        : field === 'jellyfinUserId'
          ? '1123456789abcdef0123456789abcdef'
          : `fixture-rotated-${field}`;
    await repository.update(2, { [field]: changed });
    const current = await ownActor();
    assert.equal(current[field], changed);
    assert.notEqual(current[field], snapshot[field]);
    await repository.update(2, { [field]: null });
    const unlinked = await ownActor();
    assert.equal(unlinked[field], null);
    assert.notEqual(
      unlinked.plexToken,
      'fixture-owner-token-must-not-be-borrowed'
    );
  }
});

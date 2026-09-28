import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddDiscoveryAccounts1790630400000 } from './1790630400000-AddDiscoveryAccounts';

test('discovery account migration enforces one connection per provider and cascades user deletion', async () => {
  const db = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const runner = db.createQueryRunner();
  const migration = new AddDiscoveryAccounts1790630400000();
  try {
    await runner.query(
      'CREATE TABLE "user" ("id" integer PRIMARY KEY NOT NULL)'
    );
    await runner.query('INSERT INTO "user" ("id") VALUES (1)');
    await migration.up(runner);
    const insert =
      'INSERT INTO "discovery_account" ("userId","provider","clientId","accessToken") VALUES (1,?,\'application\',\'credential\')';
    await runner.query(insert, ['trakt']);
    await assert.rejects(() => runner.query(insert, ['trakt']), /UNIQUE/);
    await runner.query(insert, ['anilist']);
    const defaults = await runner.query(
      'SELECT "allowWrites", "linkedAt" FROM "discovery_account"'
    );
    assert.equal(defaults.length, 2);
    assert.equal(defaults[0].allowWrites, 0);
    assert.ok(defaults[0].linkedAt);
    await runner.query('DELETE FROM "user" WHERE "id"=1');
    assert.deepEqual(
      await runner.query('SELECT "id" FROM "discovery_account"'),
      []
    );
    await migration.down(runner);
    assert.equal(await runner.hasTable('discovery_account'), false);
  } finally {
    await runner.release();
    await db.destroy();
  }
});

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DataSource } from 'typeorm';
import { AddProviderManagedBookSearch1790910000000 } from './1790910000000-AddProviderManagedBookSearch';

it('adds provider-owned book search tracking without changing existing rows', async () => {
  const db = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const runner = db.createQueryRunner();
  const migration = new AddProviderManagedBookSearch1790910000000();

  try {
    await runner.query(
      'CREATE TABLE "book_request_search" ("id" integer PRIMARY KEY, "state" varchar(32) NOT NULL)'
    );
    await runner.query(
      `INSERT INTO "book_request_search" ("id", "state") VALUES (1, 'searching')`
    );

    await migration.up(runner);
    const [existing] = await runner.query(
      'SELECT "providerManagedSearch" FROM "book_request_search" WHERE "id" = 1'
    );
    assert.equal(existing.providerManagedSearch, 0);

    await runner.query(
      `INSERT INTO "book_request_search" ("id", "state", "providerManagedSearch") VALUES (2, 'monitoring', 1)`
    );
    const [managed] = await runner.query(
      'SELECT "providerManagedSearch" FROM "book_request_search" WHERE "id" = 2'
    );
    assert.equal(managed.providerManagedSearch, 1);

    await migration.down(runner);
    const table = await runner.getTable('book_request_search');
    assert.equal(table?.findColumnByName('providerManagedSearch'), undefined);
  } finally {
    await runner.release();
    await db.destroy();
  }
});

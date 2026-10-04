import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaQuota1790986403000 } from './1790986403000-AddMangaQuota';

test('SQLite manga quota migration adds nullable integer columns reversibly', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaQuota1790986403000();
  const mangaColumns = async () =>
    (
      (await queryRunner.query(`PRAGMA table_info("user")`)) as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    )
      .filter((column) => column.name.startsWith('manga'))
      .map(({ name, type, notnull, dflt_value }) => ({
        name,
        type: type.toLowerCase(),
        notnull,
        dflt_value,
      }));
  try {
    await queryRunner.query(
      `CREATE TABLE "user" (
        "id" integer PRIMARY KEY,
        "email" varchar NOT NULL
      )`
    );
    await queryRunner.query(
      `INSERT INTO "user" ("id", "email") VALUES (1, 'reader@example.com')`
    );

    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.deepEqual(await mangaColumns(), [
      {
        name: 'mangaQuotaLimit',
        type: 'integer',
        notnull: 0,
        dflt_value: null,
      },
      { name: 'mangaQuotaDays', type: 'integer', notnull: 0, dflt_value: null },
    ]);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "mangaQuotaLimit", "mangaQuotaDays" FROM "user"`
      ),
      [{ mangaQuotaLimit: null, mangaQuotaDays: null }]
    );

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(await mangaColumns(), []);
    assert.deepEqual(await queryRunner.query(`SELECT "id" FROM "user"`), [
      { id: 1 },
    ]);
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

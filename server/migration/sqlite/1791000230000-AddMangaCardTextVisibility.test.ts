import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaCardTextVisibility1791000230000 } from './1791000230000-AddMangaCardTextVisibility';

test('SQLite manga card text migration adds a nullable column reversibly', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaCardTextVisibility1791000230000();
  const cardTextColumns = async () =>
    (
      (await queryRunner.query(`PRAGMA table_info("user_settings")`)) as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    )
      .filter((column) => column.name.startsWith('cardTextVisibility'))
      .map(({ name, type, notnull, dflt_value }) => ({
        name,
        type: type.toLowerCase(),
        notnull,
        dflt_value,
      }));
  try {
    await queryRunner.query(
      `CREATE TABLE "user_settings" (
        "id" integer PRIMARY KEY,
        "cardTextVisibilityMovie" varchar,
        "cardTextVisibilityBook" varchar
      )`
    );
    await queryRunner.query(
      `INSERT INTO "user_settings" ("id", "cardTextVisibilityMovie", "cardTextVisibilityBook") VALUES (1, 'always', 'hover')`
    );

    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.deepEqual(await cardTextColumns(), [
      {
        name: 'cardTextVisibilityMovie',
        type: 'varchar',
        notnull: 0,
        dflt_value: null,
      },
      {
        name: 'cardTextVisibilityBook',
        type: 'varchar',
        notnull: 0,
        dflt_value: null,
      },
      {
        name: 'cardTextVisibilityManga',
        type: 'varchar',
        notnull: 0,
        dflt_value: null,
      },
    ]);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "cardTextVisibilityMovie", "cardTextVisibilityBook", "cardTextVisibilityManga" FROM "user_settings"`
      ),
      [
        {
          cardTextVisibilityMovie: 'always',
          cardTextVisibilityBook: 'hover',
          cardTextVisibilityManga: null,
        },
      ]
    );

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(
      (await cardTextColumns()).map(({ name }) => name),
      ['cardTextVisibilityMovie', 'cardTextVisibilityBook']
    );
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "cardTextVisibilityMovie", "cardTextVisibilityBook" FROM "user_settings"`
      ),
      [{ cardTextVisibilityMovie: 'always', cardTextVisibilityBook: 'hover' }]
    );
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

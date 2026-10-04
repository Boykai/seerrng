import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddAnilistPlanningImport1791000110000 } from './1791000110000-AddAnilistPlanningImport';

test('SQLite AniList Planning import migration adds account columns reversibly', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddAnilistPlanningImport1791000110000();
  const columns = async () =>
    (
      (await queryRunner.query(`PRAGMA table_info("discovery_account")`)) as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    ).map(({ name, type, notnull, dflt_value }) => ({
      name,
      type: type.toLowerCase(),
      notnull,
      dflt_value,
    }));
  try {
    await queryRunner.query(
      `CREATE TABLE "discovery_account" (
        "id" integer PRIMARY KEY,
        "allowWrites" boolean NOT NULL DEFAULT (0)
      )`
    );
    await queryRunner.query(
      `INSERT INTO "discovery_account" ("id", "allowWrites") VALUES (1, 1)`
    );

    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.deepEqual((await columns()).slice(2), [
      {
        name: 'importMangaPlanning',
        type: 'boolean',
        notnull: 1,
        dflt_value: '0',
      },
      {
        name: 'mangaPlanningCursor',
        type: 'integer',
        notnull: 0,
        dflt_value: null,
      },
      {
        name: 'mangaPlanningCursorId',
        type: 'integer',
        notnull: 0,
        dflt_value: null,
      },
    ]);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "allowWrites", "importMangaPlanning", "mangaPlanningCursor", "mangaPlanningCursorId" FROM "discovery_account"`
      ),
      [
        {
          allowWrites: 1,
          importMangaPlanning: 0,
          mangaPlanningCursor: null,
          mangaPlanningCursorId: null,
        },
      ]
    );

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(
      (await columns()).map(({ name }) => name),
      ['id', 'allowWrites']
    );
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

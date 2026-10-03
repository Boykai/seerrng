import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaMatchProposals1790986405000 } from './1790986405000-AddMangaMatchProposals';

const ADDED = [
  { name: 'malId', type: 'integer' },
  { name: 'malCheckedAt', type: 'datetime' },
  { name: 'mangadexCheckedAt', type: 'datetime' },
  { name: 'titleCheckedAt', type: 'datetime' },
  { name: 'proposedAnilistId', type: 'integer' },
  { name: 'proposalConfidence', type: 'varchar(16)' },
  { name: 'proposalScore', type: 'integer' },
];

test('SQLite manga match proposal migration adds nullable columns reversibly', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaMatchProposals1790986405000();
  const columns = async () =>
    (
      (await queryRunner.query(
        `PRAGMA table_info("manga_match_candidate")`
      )) as {
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
      `CREATE TABLE "manga_match_candidate" (
        "id" integer PRIMARY KEY,
        "title" varchar(512) NOT NULL
      )`
    );
    await queryRunner.query(
      `INSERT INTO "manga_match_candidate" ("id", "title") VALUES (1, 'Fake Library Title 1')`
    );
    const original = await columns();

    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.deepEqual(await columns(), [
      ...original,
      ...ADDED.map((column) => ({ ...column, notnull: 0, dflt_value: null })),
    ]);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "malId", "malCheckedAt", "proposedAnilistId", "proposalConfidence" FROM "manga_match_candidate"`
      ),
      [
        {
          malId: null,
          malCheckedAt: null,
          proposedAnilistId: null,
          proposalConfidence: null,
        },
      ]
    );

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(await columns(), original);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "id", "title" FROM "manga_match_candidate"`
      ),
      [{ id: 1, title: 'Fake Library Title 1' }]
    );
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaWatchlistSync1791000100000 } from './1791000100000-AddMangaWatchlistSync';

test('SQLite manga watchlist sync migration adds a nullable column reversibly', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaWatchlistSync1791000100000();
  const syncColumns = async () =>
    (
      (await queryRunner.query(`PRAGMA table_info("user_settings")`)) as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    )
      .filter((column) => column.name.startsWith('watchlistSync'))
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
        "watchlistSyncComics" boolean
      )`
    );
    await queryRunner.query(
      `INSERT INTO "user_settings" ("id", "watchlistSyncComics") VALUES (1, 1)`
    );

    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.deepEqual(await syncColumns(), [
      {
        name: 'watchlistSyncComics',
        type: 'boolean',
        notnull: 0,
        dflt_value: null,
      },
      {
        name: 'watchlistSyncManga',
        type: 'boolean',
        notnull: 0,
        dflt_value: null,
      },
    ]);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "watchlistSyncComics", "watchlistSyncManga" FROM "user_settings"`
      ),
      [{ watchlistSyncComics: 1, watchlistSyncManga: null }]
    );

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(
      (await syncColumns()).map(({ name }) => name),
      ['watchlistSyncComics']
    );
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

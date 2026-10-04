import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryRunner } from 'typeorm';
import { AddMangaWatchlistSync1791000100000 } from './1791000100000-AddMangaWatchlistSync';

const recordStatements = async (
  run: (queryRunner: QueryRunner) => Promise<void>
) => {
  const statements: string[] = [];
  const queryRunner = {
    query: async (statement: string) => {
      statements.push(statement);
    },
  } as QueryRunner;
  await run(queryRunner);
  return statements;
};

test('PostgreSQL manga watchlist sync migration only adds and drops one nullable column', async () => {
  const migration = new AddMangaWatchlistSync1791000100000();

  assert.equal(migration.name, 'AddMangaWatchlistSync1791000100000');
  assert.deepStrictEqual(
    await recordStatements(async (queryRunner) => {
      await migration.up(queryRunner);
      await migration.down(queryRunner);
    }),
    [
      `ALTER TABLE "user_settings" ADD "watchlistSyncManga" boolean`,
      `ALTER TABLE "user_settings" DROP COLUMN "watchlistSyncManga"`,
    ]
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddDiscoverMovieFeedSnapshots1790986700000 } from './1790986700000-AddDiscoverMovieFeedSnapshots';

test('discover movie feed snapshot migration creates and removes its cache table', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddDiscoverMovieFeedSnapshots1790986700000();

  try {
    await migration.up(queryRunner);
    await queryRunner.query(
      'INSERT INTO "discover_movie_feed_snapshot" ("cacheKey", "payload", "fetchedAt") VALUES (?, ?, ?)',
      ['a'.repeat(64), '{"results":[]}', '2026-10-03 00:00:00']
    );
    assert.deepEqual(
      await queryRunner.query(
        'SELECT "cacheKey", "payload" FROM "discover_movie_feed_snapshot"'
      ),
      [{ cacheKey: 'a'.repeat(64), payload: '{"results":[]}' }]
    );

    await migration.down(queryRunner);
    assert.equal(
      (
        await queryRunner.query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discover_movie_feed_snapshot'`
        )
      ).length,
      0
    );
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

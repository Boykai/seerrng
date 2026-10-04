import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddVideoMetadataCacheExpiry1790986600000 } from './1790986600000-AddVideoMetadataCacheExpiry';

test('video metadata expiry migration backfills source cache dates and is reversible', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddVideoMetadataCacheExpiry1790986600000();

  try {
    await queryRunner.query(`
      CREATE TABLE "media_search_metadata" (
        "mediaId" integer PRIMARY KEY,
        "format" text,
        "provider" text,
        "createdAt" datetime,
        "videoMetadataExpiresAt" datetime
      )
    `);
    await queryRunner.query(`
      INSERT INTO "media_search_metadata" ("mediaId", "format", "provider", "createdAt")
      VALUES
        (1, 'Movie', 'TMDB', datetime('now', '-7 months')),
        (2, 'Series', 'TMDB TVDB', datetime('now', '-1 month')),
        (3, 'Series', 'Sonarr', datetime('now', '-1 month')),
        (4, 'Album', 'TMDB', datetime('now', '-1 month'))
    `);

    await migration.up(queryRunner);

    const backfilled = await queryRunner.query(
      `SELECT "mediaId", "videoMetadataExpiresAt" FROM "media_search_metadata" ORDER BY "mediaId"`
    );
    assert.equal(
      backfilled[0].videoMetadataExpiresAt <= new Date().toISOString(),
      true
    );
    assert.equal(
      new Date(backfilled[1].videoMetadataExpiresAt).getTime() > Date.now(),
      true
    );
    assert.equal(backfilled[2].videoMetadataExpiresAt, null);
    assert.equal(backfilled[3].videoMetadataExpiresAt, null);

    await migration.down(queryRunner);
    assert.equal(
      await queryRunner.hasColumn(
        'media_search_metadata',
        'videoMetadataExpiresAt'
      ),
      false
    );
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddVideoMetadataSourceRecords1790986402000 } from './1790986402000-AddVideoMetadataSourceRecords';

test('video metadata source migration stores provider snapshots and is reversible', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddVideoMetadataSourceRecords1790986402000();

  try {
    await migration.up(queryRunner);
    await queryRunner.query(
      `INSERT INTO "video_metadata_source_record" ("mediaType", "provider", "sourceId", "tmdbId", "tvdbId", "payload", "fetchedAt", "refreshAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'tv',
        'tvmaze',
        '169',
        1234,
        5678,
        JSON.stringify({ title: 'Example Series', overview: 'A summary' }),
        '2026-10-01 00:00:00',
        '2026-10-08 00:00:00',
        '2027-04-01 00:00:00',
      ]
    );
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "provider", "sourceId", "tmdbId", "tvdbId" FROM "video_metadata_source_record" WHERE "mediaType" = ? AND "tmdbId" = ?`,
        ['tv', 1234]
      ),
      [{ provider: 'tvmaze', sourceId: '169', tmdbId: 1234, tvdbId: 5678 }]
    );

    await assert.rejects(
      queryRunner.query(
        `INSERT INTO "video_metadata_source_record" ("mediaType", "provider", "sourceId", "payload", "fetchedAt", "refreshAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          'tv',
          'tvmaze',
          '169',
          '{}',
          '2026-10-01 00:00:00',
          '2026-10-08 00:00:00',
          '2027-04-01 00:00:00',
        ]
      )
    );

    await migration.down(queryRunner);
    assert.equal(
      (
        await queryRunner.query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'video_metadata_source_record'`
        )
      ).length,
      0
    );
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

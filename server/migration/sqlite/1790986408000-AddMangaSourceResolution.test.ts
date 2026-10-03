import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaSourceResolution1790986408000 } from './1790986408000-AddMangaSourceResolution';

test('SQLite manga source resolution migration is idempotent and reverses', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaSourceResolution1790986408000();
  const objects = async () =>
    (
      (await queryRunner.query(
        `SELECT type, name FROM sqlite_master
         WHERE tbl_name IN ('manga_source_resolution', 'manga_source_candidate')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
      )) as { type: string; name: string }[]
    ).map(({ type, name }) => `${type} ${name}`);
  const insertResolution = (instanceId: number, anilistId: number) =>
    queryRunner.query(
      `INSERT INTO "manga_source_resolution" ("instanceId", "anilistId") VALUES (?, ?)`,
      [instanceId, anilistId]
    );
  const insertCandidate = (anilistId: number, urlHash: string) =>
    queryRunner.query(
      `INSERT INTO "manga_source_candidate" ("instanceId", "anilistId", "sourceId", "url", "urlHash", "suwayomiMangaId", "title", "score", "confidence", "matchedBy") VALUES (1, ?, '7', '/fake/item', ?, 11, 'Invented Title', 800, 'MEDIUM', 'title')`,
      [anilistId, urlHash]
    );
  try {
    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.deepEqual(await objects(), [
      'index UQ_manga_source_candidate_item',
      'index UQ_manga_source_resolution_title',
      'table manga_source_candidate',
      'table manga_source_resolution',
    ]);

    await insertResolution(1, 900001);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "status", "reason", "mangadexUuid", "searchRequestedAt", "checkedAt", "searchedAt", "attempts", "nextAttemptAt", "lastError", "createdAt" IS NOT NULL AS "stamped"
         FROM "manga_source_resolution"`
      ),
      [
        {
          status: 'QUEUED',
          reason: null,
          mangadexUuid: null,
          searchRequestedAt: null,
          checkedAt: null,
          searchedAt: null,
          attempts: 0,
          nextAttemptAt: null,
          lastError: null,
          stamped: 1,
        },
      ]
    );
    // One row per title and instance.
    await assert.rejects(
      insertResolution(1, 900001),
      /UNIQUE constraint failed/
    );
    await insertResolution(2, 900001);

    // One candidate per source manga and title.
    await insertCandidate(900001, 'hash-a');
    await assert.rejects(
      insertCandidate(900001, 'hash-a'),
      /UNIQUE constraint failed/
    );
    await insertCandidate(900002, 'hash-a');
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "sourceName", "sourceLang", "inLibrary", "createdAt" IS NOT NULL AS "stamped" FROM "manga_source_candidate" WHERE "anilistId" = 900002`
      ),
      [{ sourceName: '', sourceLang: '', inLibrary: 0, stamped: 1 }]
    );

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(await objects(), []);
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

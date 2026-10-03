import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaRequestManifests1790986406000 } from './1790986406000-AddMangaRequestManifests';

test('SQLite manga request manifest migration is idempotent, cascades and reverses', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaRequestManifests1790986406000();
  const objects = async () =>
    (
      (await queryRunner.query(
        `SELECT type, name FROM sqlite_master
         WHERE tbl_name IN ('manga_request_manifest', 'manga_request_chapter')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
      )) as { type: string; name: string }[]
    ).map(({ type, name }) => `${type} ${name}`);
  const insertManifest = (requestId: number) =>
    queryRunner.query(
      `INSERT INTO "manga_request_manifest" ("requestId", "anilistId", "instanceId") VALUES (?, 900001, 1)`,
      [requestId]
    );
  const insertChapter = (manifestId: number, item: string) =>
    queryRunner.query(
      `INSERT INTO "manga_request_chapter" ("manifestId", "url", "urlHash", "chapterNumber") VALUES (?, ?, ?, 1.5)`,
      [manifestId, `/fake/chapter/${item}`, `hash-${item}`]
    );
  try {
    await queryRunner.query(
      `CREATE TABLE "media_request" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
    );
    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.deepEqual(await objects(), [
      'index IDX_manga_request_manifest_anilistId',
      'index IDX_manga_request_manifest_instanceId',
      'table manga_request_chapter',
      'table manga_request_manifest',
    ]);

    await queryRunner.query(
      `INSERT INTO "media_request" ("id") VALUES (1), (2)`
    );
    await insertManifest(1);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "scope", "latestCount", "rangeStart", "rangeEnd", "bindingState", "boundAt", "checkpoint", "attempts", "lastError", "frozenAt", "createdAt" IS NOT NULL AS "stamped"
         FROM "manga_request_manifest"`
      ),
      [
        {
          scope: 'ALL_AT_DISPATCH',
          latestCount: null,
          rangeStart: null,
          rangeEnd: null,
          bindingState: 'AWAITING_BINDING',
          boundAt: null,
          checkpoint: null,
          attempts: 0,
          lastError: null,
          frozenAt: null,
          stamped: 1,
        },
      ]
    );
    // One manifest per request.
    await assert.rejects(insertManifest(1), /UNIQUE constraint failed/);
    await insertManifest(2);

    // Chapters are keyed by URL within a manifest.
    const [{ id: manifestId }] = (await queryRunner.query(
      `SELECT "id" FROM "manga_request_manifest" WHERE "requestId" = 1`
    )) as { id: number }[];
    const [{ id: otherManifestId }] = (await queryRunner.query(
      `SELECT "id" FROM "manga_request_manifest" WHERE "requestId" = 2`
    )) as { id: number }[];
    await insertChapter(manifestId, 'a');
    await insertChapter(manifestId, 'b');
    await assert.rejects(
      insertChapter(manifestId, 'a'),
      /UNIQUE constraint failed/
    );
    await insertChapter(otherManifestId, 'a');
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "chapterNumber", "scanlator" FROM "manga_request_chapter" WHERE "urlHash" = 'hash-b'`
      ),
      [{ chapterNumber: 1.5, scanlator: null }]
    );

    // Deleting a request removes its manifest and the manifest's chapters.
    await queryRunner.query(`DELETE FROM "media_request" WHERE "id" = 1`);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "requestId" FROM "manga_request_manifest" ORDER BY "requestId"`
      ),
      [{ requestId: 2 }]
    );
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "manifestId" FROM "manga_request_chapter"`
      ),
      [{ manifestId: otherManifestId }]
    );
    await assert.rejects(insertManifest(3), /FOREIGN KEY constraint failed/);

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(await objects(), []);
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

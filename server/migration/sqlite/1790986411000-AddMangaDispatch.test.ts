import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaRequestManifests1790986406000 } from './1790986406000-AddMangaRequestManifests';
import { AddMangaDispatch1790986411000 } from './1790986411000-AddMangaDispatch';

const DISPATCH_TABLES = [
  'manga_chapter_ownership',
  'manga_instance_marker',
  'manga_library_ownership',
];
const MANIFEST_COLUMNS = [
  'bindingSourceId',
  'bindingUrlHash',
  'suwayomiMangaId',
  'retryNotBefore',
];

test('SQLite manga dispatch migration is idempotent, keys what SeerrNG owns and reverses', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaDispatch1790986411000();
  const objects = async () =>
    (
      (await queryRunner.query(
        `SELECT type, name FROM sqlite_master
         WHERE (tbl_name IN (${DISPATCH_TABLES.map(() => '?').join(', ')})
             OR name = 'IDX_manga_request_manifest_binding')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
        DISPATCH_TABLES
      )) as { type: string; name: string }[]
    ).map(({ type, name }) => `${type} ${name}`);
  const manifestColumns = async () =>
    (
      (await queryRunner.query(
        `SELECT name, type FROM pragma_table_info('manga_request_manifest')`
      )) as { name: string; type: string }[]
    )
      .filter(({ name }) => MANIFEST_COLUMNS.includes(name))
      .map(({ name, type }) => `${name} ${type.toLowerCase()}`);
  const uniqueKeys = async (table: string) => {
    const indexes = (await queryRunner.query(
      `SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND origin = 'u' ORDER BY name`,
      [table]
    )) as { name: string }[];
    const keys: string[][] = [];
    for (const { name } of indexes) {
      keys.push(
        (
          (await queryRunner.query(
            `SELECT name FROM pragma_index_info(?) ORDER BY seqno`,
            [name]
          )) as { name: string }[]
        ).map((column) => column.name)
      );
    }
    return keys;
  };
  const insertLibrary = (instanceId: number, urlHash: string) =>
    queryRunner.query(
      `INSERT INTO "manga_library_ownership" ("instanceId", "sourceId", "urlHash", "url", "addedBySeerrng") VALUES (?, '1002', ?, ?, 1)`,
      [instanceId, urlHash, `/fake/manga/${urlHash}`]
    );
  const insertChapter = (mangaUrlHash: string, chapterUrlHash: string) =>
    queryRunner.query(
      `INSERT INTO "manga_chapter_ownership" ("instanceId", "sourceId", "mangaUrlHash", "chapterUrlHash", "chapterUrl") VALUES (1, '1002', ?, ?, ?)`,
      [mangaUrlHash, chapterUrlHash, `/fake/chapter/${chapterUrlHash}`]
    );
  const insertMarker = (instanceId: number, marker: string) =>
    queryRunner.query(
      `INSERT INTO "manga_instance_marker" ("instanceId", "marker") VALUES (?, ?)`,
      [instanceId, marker]
    );
  try {
    await queryRunner.query(
      `CREATE TABLE "media_request" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
    );
    await new AddMangaRequestManifests1790986406000().up(queryRunner);
    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.equal(migration.name, 'AddMangaDispatch1790986411000');
    assert.deepEqual(await objects(), [
      'index IDX_manga_request_manifest_binding',
      'table manga_chapter_ownership',
      'table manga_instance_marker',
      'table manga_library_ownership',
    ]);
    assert.deepEqual(await manifestColumns(), [
      'bindingSourceId varchar(32)',
      'bindingUrlHash varchar(64)',
      'suwayomiMangaId integer',
      'retryNotBefore datetime',
    ]);
    assert.deepEqual(
      (
        (await queryRunner.query(
          `SELECT name FROM pragma_index_info('IDX_manga_request_manifest_binding') ORDER BY seqno`
        )) as { name: string }[]
      ).map(({ name }) => name),
      ['instanceId', 'bindingSourceId', 'bindingUrlHash']
    );
    assert.deepEqual(await uniqueKeys('manga_library_ownership'), [
      ['instanceId', 'sourceId', 'urlHash'],
    ]);
    assert.deepEqual(await uniqueKeys('manga_chapter_ownership'), [
      ['instanceId', 'sourceId', 'mangaUrlHash', 'chapterUrlHash'],
    ]);
    assert.deepEqual((await uniqueKeys('manga_instance_marker')).sort(), [
      ['instanceId'],
      ['marker'],
    ]);

    // Existing manifests gain empty dispatch columns.
    await queryRunner.query(`INSERT INTO "media_request" ("id") VALUES (1)`);
    await queryRunner.query(
      `INSERT INTO "manga_request_manifest" ("requestId", "anilistId", "instanceId") VALUES (1, 900001, 1)`
    );
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "bindingSourceId", "bindingUrlHash", "suwayomiMangaId", "retryNotBefore" FROM "manga_request_manifest"`
      ),
      [
        {
          bindingSourceId: null,
          bindingUrlHash: null,
          suwayomiMangaId: null,
          retryNotBefore: null,
        },
      ]
    );

    // One ownership row per library entry and per chapter on an instance.
    await insertLibrary(1, 'hash-a');
    await assert.rejects(
      insertLibrary(1, 'hash-a'),
      /UNIQUE constraint failed/
    );
    await insertLibrary(2, 'hash-a');
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "createdAt" IS NOT NULL AS "stamped" FROM "manga_library_ownership"`
      ),
      [{ stamped: 1 }, { stamped: 1 }]
    );
    await insertChapter('hash-a', 'hash-1');
    await assert.rejects(
      insertChapter('hash-a', 'hash-1'),
      /UNIQUE constraint failed/
    );
    await insertChapter('hash-b', 'hash-1');
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "enqueuedAt" IS NOT NULL AS "stamped" FROM "manga_chapter_ownership"`
      ),
      [{ stamped: 1 }, { stamped: 1 }]
    );

    // One marker per instance, and no two instances share a marker.
    await insertMarker(1, 'marker-a');
    await assert.rejects(
      insertMarker(1, 'marker-b'),
      /UNIQUE constraint failed/
    );
    await assert.rejects(
      insertMarker(2, 'marker-a'),
      /UNIQUE constraint failed/
    );
    await insertMarker(2, 'marker-b');

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(await objects(), []);
    assert.deepEqual(await manifestColumns(), []);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "requestId", "anilistId" FROM "manga_request_manifest"`
      ),
      [{ requestId: 1, anilistId: 900001 }]
    );
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

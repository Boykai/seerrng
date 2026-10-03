import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaRequestManifests1790986406000 } from './1790986406000-AddMangaRequestManifests';
import { AddMangaFollow1790986414000 } from './1790986414000-AddMangaFollow';

const MANIFEST_COLUMNS = [
  'followEnabled boolean not null 0',
  'followNextAt datetime null',
  'followLastAt datetime null',
  'followStopReason varchar(64) null',
];
const CHAPTER_COLUMNS = ['followAddedAt datetime null'];
const INDEX = 'IDX_manga_request_manifest_follow_due';

test('SQLite manga follow migration is idempotent, fills existing rows and reverses', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaFollow1790986414000();
  const added = [...MANIFEST_COLUMNS, ...CHAPTER_COLUMNS].map(
    (column) => column.split(' ')[0]
  );
  const columns = async (table: string) =>
    (
      (await queryRunner.query(`SELECT * FROM pragma_table_info(?)`, [
        table,
      ])) as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    )
      .filter(({ name }) => added.includes(name))
      .map(
        ({ name, type, notnull, dflt_value }) =>
          `${name} ${type.toLowerCase()} ${notnull ? 'not null' : 'null'}${
            dflt_value === null ? '' : ` ${dflt_value}`
          }`
      );
  const indexColumns = async () =>
    (
      (await queryRunner.query(
        `SELECT name FROM pragma_index_info(?) ORDER BY seqno`,
        [INDEX]
      )) as { name: string }[]
    ).map(({ name }) => name);
  try {
    await queryRunner.query(
      `CREATE TABLE "media_request" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
    );
    await new AddMangaRequestManifests1790986406000().up(queryRunner);
    await queryRunner.query(`INSERT INTO "media_request" ("id") VALUES (1)`);
    await queryRunner.query(
      `INSERT INTO "manga_request_manifest" ("requestId", "anilistId", "instanceId") VALUES (1, 900001, 1)`
    );
    await queryRunner.query(
      `INSERT INTO "manga_request_chapter" ("manifestId", "url", "urlHash", "chapterNumber") VALUES (1, '/fake/chapter/a', 'hash-a', 1.5)`
    );

    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.equal(migration.name, 'AddMangaFollow1790986414000');
    assert.deepEqual(await columns('manga_request_manifest'), MANIFEST_COLUMNS);
    assert.deepEqual(await columns('manga_request_chapter'), CHAPTER_COLUMNS);
    assert.deepEqual(await indexColumns(), ['followEnabled', 'followNextAt']);

    // Existing requests don't follow, and their chapters came from dispatch.
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "followEnabled", "followNextAt", "followLastAt", "followStopReason"
         FROM "manga_request_manifest"`
      ),
      [
        {
          followEnabled: 0,
          followNextAt: null,
          followLastAt: null,
          followStopReason: null,
        },
      ]
    );
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "followAddedAt" FROM "manga_request_chapter"`
      ),
      [{ followAddedAt: null }]
    );

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(await columns('manga_request_manifest'), []);
    assert.deepEqual(await columns('manga_request_chapter'), []);
    assert.deepEqual(await indexColumns(), []);
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "requestId", "anilistId" FROM "manga_request_manifest"`
      ),
      [{ requestId: 1, anilistId: 900001 }]
    );
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "manifestId", "urlHash" FROM "manga_request_chapter"`
      ),
      [{ manifestId: 1, urlHash: 'hash-a' }]
    );
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaRequestManifests1790986406000 } from './1790986406000-AddMangaRequestManifests';
import { AddMangaProgress1790986412000 } from './1790986412000-AddMangaProgress';

const MANIFEST_COLUMNS = [
  'attentionCode varchar(64) null',
  'attentionAt datetime null',
  'progressAt datetime null',
  'progressSignature varchar(64) null',
  'chaptersTotal integer not null 0',
  'chaptersVerified integer not null 0',
  'chaptersQueued integer not null 0',
  'chaptersDownloading integer not null 0',
  'chaptersErrored integer not null 0',
  'chaptersMissing integer not null 0',
];
const CHAPTER_COLUMNS = [
  'deliverableAt datetime null',
  'lastQueueState varchar(16) null',
  'missingSince datetime null',
  'fileState varchar(16) null',
  'headCheckedAt datetime null',
];

test('SQLite manga progress migration is idempotent, fills existing rows and reverses', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaProgress1790986412000();
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

    assert.equal(migration.name, 'AddMangaProgress1790986412000');
    assert.deepEqual(await columns('manga_request_manifest'), MANIFEST_COLUMNS);
    assert.deepEqual(await columns('manga_request_chapter'), CHAPTER_COLUMNS);

    // Existing manifests start unpolled, with every count at zero.
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "attentionCode", "attentionAt", "progressAt", "progressSignature",
                "chaptersTotal", "chaptersVerified", "chaptersQueued",
                "chaptersDownloading", "chaptersErrored", "chaptersMissing"
         FROM "manga_request_manifest"`
      ),
      [
        {
          attentionCode: null,
          attentionAt: null,
          progressAt: null,
          progressSignature: null,
          chaptersTotal: 0,
          chaptersVerified: 0,
          chaptersQueued: 0,
          chaptersDownloading: 0,
          chaptersErrored: 0,
          chaptersMissing: 0,
        },
      ]
    );
    // Existing frozen rows start unverified.
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "deliverableAt", "lastQueueState", "missingSince", "fileState", "headCheckedAt"
         FROM "manga_request_chapter"`
      ),
      [
        {
          deliverableAt: null,
          lastQueueState: null,
          missingSince: null,
          fileState: null,
          headCheckedAt: null,
        },
      ]
    );

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(await columns('manga_request_manifest'), []);
    assert.deepEqual(await columns('manga_request_chapter'), []);
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

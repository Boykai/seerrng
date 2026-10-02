import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { AddMangaIdentityUniqueness1790986402000 } from './1790986402000-AddMangaIdentityUniqueness';

test('SQLite manga identity migration enforces one AniList owner reversibly', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaIdentityUniqueness1790986402000();
  const insertIdentifier = (
    id: number,
    mediaId: number,
    provider: string,
    value: string
  ) =>
    queryRunner.query(
      `INSERT INTO "media_identifier" ("id", "mediaId", "provider", "value")
       VALUES (?, ?, ?, ?)`,
      [id, mediaId, provider, value]
    );
  try {
    await queryRunner.query(
      `CREATE TABLE "media_identifier" (
        "id" integer PRIMARY KEY,
        "mediaId" integer,
        "provider" varchar NOT NULL,
        "value" varchar NOT NULL
      )`
    );
    await insertIdentifier(1, 1, 'anilist', '30013');

    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.deepEqual(
      await queryRunner.query(
        `SELECT "name" FROM "sqlite_master"
         WHERE "type" = 'index' AND "tbl_name" = 'media_identifier'`
      ),
      [{ name: 'UQ_media_identifier_canonical_manga' }]
    );
    await assert.rejects(insertIdentifier(2, 2, 'anilist', '30013'), /unique/i);

    // Cross-reference providers stay non-unique: several titles can share them.
    await insertIdentifier(3, 1, 'mangadex', 'shared');
    await insertIdentifier(4, 2, 'mangadex', 'shared');
    await insertIdentifier(5, 1, 'mal', '13');
    await insertIdentifier(6, 2, 'mal', '13');
    await insertIdentifier(7, 1, 'mangaupdates', 'series');
    await insertIdentifier(8, 2, 'mangaupdates', 'series');
    await insertIdentifier(9, 2, 'anilist', '30002');

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(
      await queryRunner.query(
        `SELECT "name" FROM "sqlite_master"
         WHERE "type" = 'index' AND "tbl_name" = 'media_identifier'`
      ),
      []
    );
    await insertIdentifier(10, 3, 'anilist', '30013');
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

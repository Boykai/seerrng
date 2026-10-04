import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaSourceResolution1790986408000 implements MigrationInterface {
  name = 'AddMangaSourceResolution1790986408000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_source_resolution" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "instanceId" integer NOT NULL, "anilistId" integer NOT NULL, "status" varchar(16) NOT NULL DEFAULT ('QUEUED'), "reason" varchar(32), "mangadexUuid" varchar(36), "searchRequestedAt" datetime, "checkedAt" datetime, "searchedAt" datetime, "attempts" integer NOT NULL DEFAULT (0), "nextAttemptAt" datetime, "lastError" varchar(64), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_manga_source_resolution_title" ON "manga_source_resolution" ("instanceId", "anilistId")`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_source_candidate" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "instanceId" integer NOT NULL, "anilistId" integer NOT NULL, "sourceId" varchar(32) NOT NULL, "sourceName" varchar(256) NOT NULL DEFAULT (''), "sourceLang" varchar(32) NOT NULL DEFAULT (''), "url" varchar(2048) NOT NULL, "urlHash" varchar(64) NOT NULL, "suwayomiMangaId" integer NOT NULL, "title" varchar(512) NOT NULL, "inLibrary" boolean NOT NULL DEFAULT (0), "score" integer NOT NULL, "confidence" varchar(16) NOT NULL, "matchedBy" varchar(32) NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_manga_source_candidate_item" ON "manga_source_candidate" ("instanceId", "anilistId", "sourceId", "urlHash")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_source_candidate"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_source_resolution"`);
  }
}

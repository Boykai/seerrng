import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaLibraryBindings1790986404000 implements MigrationInterface {
  name = 'AddMangaLibraryBindings1790986404000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_source_binding" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "instanceId" integer NOT NULL, "sourceId" varchar(32) NOT NULL, "url" varchar(2048) NOT NULL, "urlHash" varchar(64) NOT NULL, "suwayomiMangaId" integer, "anilistId" integer NOT NULL, "confidence" varchar(16) NOT NULL, "matchedBy" varchar(32) NOT NULL, "origin" varchar(16) NOT NULL, "state" varchar(16) NOT NULL, "inLibrary" boolean NOT NULL DEFAULT (0), "chapterCount" integer, "downloadCount" integer, "availability" integer NOT NULL DEFAULT (1), "title" varchar(512), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP))`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_manga_source_binding_anilistId" ON "manga_source_binding" ("anilistId")`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_manga_source_binding_pair" ON "manga_source_binding" ("instanceId", "sourceId", "urlHash", "anilistId")`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_manga_source_binding_live" ON "manga_source_binding" ("instanceId", "sourceId", "urlHash") WHERE "state" IN ('ACTIVE', 'ORPHANED')`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_match_candidate" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "instanceId" integer NOT NULL, "sourceId" varchar(32) NOT NULL, "url" varchar(2048) NOT NULL, "urlHash" varchar(64) NOT NULL, "suwayomiMangaId" integer NOT NULL, "title" varchar(512) NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_manga_match_candidate_item" ON "manga_match_candidate" ("instanceId", "sourceId", "urlHash")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_match_candidate"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_source_binding"`);
  }
}

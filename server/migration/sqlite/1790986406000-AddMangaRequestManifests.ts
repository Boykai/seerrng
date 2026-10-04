import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaRequestManifests1790986406000 implements MigrationInterface {
  name = 'AddMangaRequestManifests1790986406000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_request_manifest" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "requestId" integer NOT NULL, "anilistId" integer NOT NULL, "instanceId" integer NOT NULL, "scope" varchar(16) NOT NULL DEFAULT ('ALL_AT_DISPATCH'), "latestCount" integer, "rangeStart" double precision, "rangeEnd" double precision, "bindingState" varchar(32) NOT NULL DEFAULT ('AWAITING_BINDING'), "boundAt" datetime, "checkpoint" varchar(32), "checkpointAt" datetime, "attempts" integer NOT NULL DEFAULT (0), "lastError" varchar(64), "frozenAt" datetime, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_manga_request_manifest_request" UNIQUE ("requestId"), CONSTRAINT "FK_manga_request_manifest_request" FOREIGN KEY ("requestId") REFERENCES "media_request" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_manga_request_manifest_anilistId" ON "manga_request_manifest" ("anilistId")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_manga_request_manifest_instanceId" ON "manga_request_manifest" ("instanceId")`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_request_chapter" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "manifestId" integer NOT NULL, "url" varchar(2048) NOT NULL, "urlHash" varchar(64) NOT NULL, "chapterNumber" double precision, "scanlator" varchar(255), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_manga_request_chapter_manifest_url" UNIQUE ("manifestId", "urlHash"), CONSTRAINT "FK_manga_request_chapter_manifest" FOREIGN KEY ("manifestId") REFERENCES "manga_request_manifest" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_request_chapter"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_request_manifest"`);
  }
}

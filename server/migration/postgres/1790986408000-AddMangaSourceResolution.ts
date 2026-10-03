import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaSourceResolution1790986408000 implements MigrationInterface {
  name = 'AddMangaSourceResolution1790986408000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_source_resolution" ("id" SERIAL NOT NULL, "instanceId" integer NOT NULL, "anilistId" integer NOT NULL, "status" character varying(16) NOT NULL DEFAULT 'QUEUED', "reason" character varying(32), "mangadexUuid" character varying(36), "searchRequestedAt" TIMESTAMP WITH TIME ZONE, "checkedAt" TIMESTAMP WITH TIME ZONE, "searchedAt" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP WITH TIME ZONE, "lastError" character varying(64), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_manga_source_resolution" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_manga_source_resolution_title" ON "manga_source_resolution" ("instanceId", "anilistId")`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_source_candidate" ("id" SERIAL NOT NULL, "instanceId" integer NOT NULL, "anilistId" integer NOT NULL, "sourceId" character varying(32) NOT NULL, "sourceName" character varying(256) NOT NULL DEFAULT '', "sourceLang" character varying(32) NOT NULL DEFAULT '', "url" character varying(2048) NOT NULL, "urlHash" character varying(64) NOT NULL, "suwayomiMangaId" integer NOT NULL, "title" character varying(512) NOT NULL, "inLibrary" boolean NOT NULL DEFAULT false, "score" integer NOT NULL, "confidence" character varying(16) NOT NULL, "matchedBy" character varying(32) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_manga_source_candidate" PRIMARY KEY ("id"))`
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

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaLibraryBindings1790986404000 implements MigrationInterface {
  name = 'AddMangaLibraryBindings1790986404000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_source_binding" ("id" SERIAL NOT NULL, "instanceId" integer NOT NULL, "sourceId" character varying(32) NOT NULL, "url" character varying(2048) NOT NULL, "urlHash" character varying(64) NOT NULL, "suwayomiMangaId" integer, "anilistId" integer NOT NULL, "confidence" character varying(16) NOT NULL, "matchedBy" character varying(32) NOT NULL, "origin" character varying(16) NOT NULL, "state" character varying(16) NOT NULL, "inLibrary" boolean NOT NULL DEFAULT false, "chapterCount" integer, "downloadCount" integer, "availability" integer NOT NULL DEFAULT '1', "title" character varying(512), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_manga_source_binding" PRIMARY KEY ("id"))`
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
      `CREATE TABLE IF NOT EXISTS "manga_match_candidate" ("id" SERIAL NOT NULL, "instanceId" integer NOT NULL, "sourceId" character varying(32) NOT NULL, "url" character varying(2048) NOT NULL, "urlHash" character varying(64) NOT NULL, "suwayomiMangaId" integer NOT NULL, "title" character varying(512) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_manga_match_candidate" PRIMARY KEY ("id"))`
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

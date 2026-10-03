import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaDispatch1790986411000 implements MigrationInterface {
  name = 'AddMangaDispatch1790986411000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "manga_request_manifest" ADD COLUMN IF NOT EXISTS "bindingSourceId" character varying(32)`
    );
    await queryRunner.query(
      `ALTER TABLE "manga_request_manifest" ADD COLUMN IF NOT EXISTS "bindingUrlHash" character varying(64)`
    );
    await queryRunner.query(
      `ALTER TABLE "manga_request_manifest" ADD COLUMN IF NOT EXISTS "suwayomiMangaId" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "manga_request_manifest" ADD COLUMN IF NOT EXISTS "retryNotBefore" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_manga_request_manifest_binding" ON "manga_request_manifest" ("instanceId", "bindingSourceId", "bindingUrlHash")`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_library_ownership" ("id" SERIAL NOT NULL, "instanceId" integer NOT NULL, "sourceId" character varying(32) NOT NULL, "urlHash" character varying(64) NOT NULL, "url" character varying(2048) NOT NULL, "addedBySeerrng" boolean NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_manga_library_ownership_item" UNIQUE ("instanceId", "sourceId", "urlHash"), CONSTRAINT "PK_manga_library_ownership" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_chapter_ownership" ("id" SERIAL NOT NULL, "instanceId" integer NOT NULL, "sourceId" character varying(32) NOT NULL, "mangaUrlHash" character varying(64) NOT NULL, "chapterUrlHash" character varying(64) NOT NULL, "chapterUrl" character varying(2048) NOT NULL, "enqueuedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_manga_chapter_ownership_item" UNIQUE ("instanceId", "sourceId", "mangaUrlHash", "chapterUrlHash"), CONSTRAINT "PK_manga_chapter_ownership" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_instance_marker" ("id" SERIAL NOT NULL, "instanceId" integer NOT NULL, "marker" character varying(36) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_manga_instance_marker_instance" UNIQUE ("instanceId"), CONSTRAINT "UQ_manga_instance_marker_marker" UNIQUE ("marker"), CONSTRAINT "PK_manga_instance_marker" PRIMARY KEY ("id"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_instance_marker"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_chapter_ownership"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_library_ownership"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_manga_request_manifest_binding"`
    );
    await queryRunner.query(
      `ALTER TABLE "manga_request_manifest" DROP COLUMN IF EXISTS "retryNotBefore"`
    );
    await queryRunner.query(
      `ALTER TABLE "manga_request_manifest" DROP COLUMN IF EXISTS "suwayomiMangaId"`
    );
    await queryRunner.query(
      `ALTER TABLE "manga_request_manifest" DROP COLUMN IF EXISTS "bindingUrlHash"`
    );
    await queryRunner.query(
      `ALTER TABLE "manga_request_manifest" DROP COLUMN IF EXISTS "bindingSourceId"`
    );
  }
}

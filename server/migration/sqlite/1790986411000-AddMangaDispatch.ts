import type { MigrationInterface, QueryRunner } from 'typeorm';

const MANIFEST_COLUMNS = [
  ['bindingSourceId', 'varchar(32)'],
  ['bindingUrlHash', 'varchar(64)'],
  ['suwayomiMangaId', 'integer'],
  ['retryNotBefore', 'datetime'],
] as const;

export class AddMangaDispatch1790986411000 implements MigrationInterface {
  name = 'AddMangaDispatch1790986411000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [column, type] of MANIFEST_COLUMNS) {
      if (!(await queryRunner.hasColumn('manga_request_manifest', column))) {
        await queryRunner.query(
          `ALTER TABLE "manga_request_manifest" ADD "${column}" ${type}`
        );
      }
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_manga_request_manifest_binding" ON "manga_request_manifest" ("instanceId", "bindingSourceId", "bindingUrlHash")`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_library_ownership" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "instanceId" integer NOT NULL, "sourceId" varchar(32) NOT NULL, "urlHash" varchar(64) NOT NULL, "url" varchar(2048) NOT NULL, "addedBySeerrng" boolean NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_manga_library_ownership_item" UNIQUE ("instanceId", "sourceId", "urlHash"))`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_chapter_ownership" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "instanceId" integer NOT NULL, "sourceId" varchar(32) NOT NULL, "mangaUrlHash" varchar(64) NOT NULL, "chapterUrlHash" varchar(64) NOT NULL, "chapterUrl" varchar(2048) NOT NULL, "enqueuedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_manga_chapter_ownership_item" UNIQUE ("instanceId", "sourceId", "mangaUrlHash", "chapterUrlHash"))`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_instance_marker" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "instanceId" integer NOT NULL, "marker" varchar(36) NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_manga_instance_marker_instance" UNIQUE ("instanceId"), CONSTRAINT "UQ_manga_instance_marker_marker" UNIQUE ("marker"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_instance_marker"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_chapter_ownership"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_library_ownership"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_manga_request_manifest_binding"`
    );
    for (const [column] of [...MANIFEST_COLUMNS].reverse()) {
      if (await queryRunner.hasColumn('manga_request_manifest', column)) {
        await queryRunner.query(
          `ALTER TABLE "manga_request_manifest" DROP COLUMN "${column}"`
        );
      }
    }
  }
}

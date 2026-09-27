import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddComicCatalogIndex1790410000000 implements MigrationInterface {
  name = 'AddComicCatalogIndex1790410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "comic_catalog_scan" (
      "id" character varying(32) PRIMARY KEY NOT NULL,
      "scanGeneration" integer NOT NULL DEFAULT 1,
      "completeGeneration" integer NOT NULL DEFAULT 0,
      "nextPage" integer NOT NULL DEFAULT 1,
      "totalResults" integer NOT NULL DEFAULT 0,
      "indexedResults" integer NOT NULL DEFAULT 0,
      "invalidResults" integer NOT NULL DEFAULT 0,
      "lastVolumeId" integer NOT NULL DEFAULT 0,
      "lastAttemptAt" integer NOT NULL DEFAULT 0,
      "lastCompletedAt" integer NOT NULL DEFAULT 0,
      "lastError" character varying(32)
    )`);
    await queryRunner.query(`CREATE TABLE "comic_catalog_volume" (
      "generation" integer NOT NULL,
      "id" integer NOT NULL,
      "title" character varying(1000) NOT NULL,
      "searchText" text NOT NULL,
      "publisherKey" character varying(512),
      "startYear" integer,
      "issueCount" integer,
      "payload" text NOT NULL,
      PRIMARY KEY ("generation", "id")
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_comic_catalog_volume_generation_title" ON "comic_catalog_volume" ("generation", "title")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_comic_catalog_volume_generation_publisher" ON "comic_catalog_volume" ("generation", "publisherKey")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_comic_catalog_volume_generation_year" ON "comic_catalog_volume" ("generation", "startYear")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_comic_catalog_volume_generation_issues" ON "comic_catalog_volume" ("generation", "issueCount")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "comic_catalog_volume"`);
    await queryRunner.query(`DROP TABLE "comic_catalog_scan"`);
  }
}

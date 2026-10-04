import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaRequestManifests1790986406000 implements MigrationInterface {
  name = 'AddMangaRequestManifests1790986406000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_request_manifest" ("id" SERIAL NOT NULL, "requestId" integer NOT NULL, "anilistId" integer NOT NULL, "instanceId" integer NOT NULL, "scope" character varying(16) NOT NULL DEFAULT 'ALL_AT_DISPATCH', "latestCount" integer, "rangeStart" double precision, "rangeEnd" double precision, "bindingState" character varying(32) NOT NULL DEFAULT 'AWAITING_BINDING', "boundAt" TIMESTAMP WITH TIME ZONE, "checkpoint" character varying(32), "checkpointAt" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT 0, "lastError" character varying(64), "frozenAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_manga_request_manifest_request" UNIQUE ("requestId"), CONSTRAINT "PK_manga_request_manifest" PRIMARY KEY ("id"), CONSTRAINT "FK_manga_request_manifest_request" FOREIGN KEY ("requestId") REFERENCES "media_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_manga_request_manifest_anilistId" ON "manga_request_manifest" ("anilistId")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_manga_request_manifest_instanceId" ON "manga_request_manifest" ("instanceId")`
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "manga_request_chapter" ("id" SERIAL NOT NULL, "manifestId" integer NOT NULL, "url" character varying(2048) NOT NULL, "urlHash" character varying(64) NOT NULL, "chapterNumber" double precision, "scanlator" character varying(255), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_manga_request_chapter_manifest_url" UNIQUE ("manifestId", "urlHash"), CONSTRAINT "PK_manga_request_chapter" PRIMARY KEY ("id"), CONSTRAINT "FK_manga_request_chapter_manifest" FOREIGN KEY ("manifestId") REFERENCES "manga_request_manifest"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_request_chapter"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "manga_request_manifest"`);
  }
}

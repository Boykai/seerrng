import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVideoMetadataSourceRecords1790986402000 implements MigrationInterface {
  name = 'AddVideoMetadataSourceRecords1790986402000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "video_metadata_source_record" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "mediaType" varchar(16) NOT NULL,
        "provider" varchar(16) NOT NULL,
        "sourceId" varchar(256) NOT NULL,
        "tmdbId" integer,
        "tvdbId" integer,
        "imdbId" varchar(32),
        "tvmazeId" integer,
        "wikidataId" varchar(32),
        "payload" text NOT NULL,
        "attributionUrl" text,
        "fetchedAt" datetime NOT NULL,
        "refreshAt" datetime NOT NULL,
        "expiresAt" datetime NOT NULL,
        CONSTRAINT "UQ_video_metadata_source_identity"
          UNIQUE ("mediaType", "provider", "sourceId")
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_video_metadata_source_tmdb" ON "video_metadata_source_record" ("mediaType", "tmdbId")'
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_video_metadata_source_tvdb" ON "video_metadata_source_record" ("mediaType", "tvdbId")'
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_video_metadata_source_imdb" ON "video_metadata_source_record" ("mediaType", "imdbId")'
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_video_metadata_source_tvmaze" ON "video_metadata_source_record" ("mediaType", "tvmazeId")'
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_video_metadata_source_wikidata" ON "video_metadata_source_record" ("mediaType", "wikidataId")'
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_video_metadata_source_expiry" ON "video_metadata_source_record" ("expiresAt")'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "video_metadata_source_record"');
  }
}

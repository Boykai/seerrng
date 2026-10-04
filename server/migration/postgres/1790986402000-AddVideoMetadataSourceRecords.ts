import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVideoMetadataSourceRecords1790986402000 implements MigrationInterface {
  name = 'AddVideoMetadataSourceRecords1790986402000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "video_metadata_source_record" (
        "id" SERIAL NOT NULL,
        "mediaType" character varying(16) NOT NULL,
        "provider" character varying(16) NOT NULL,
        "sourceId" character varying(256) NOT NULL,
        "tmdbId" integer,
        "tvdbId" integer,
        "imdbId" character varying(32),
        "tvmazeId" integer,
        "wikidataId" character varying(32),
        "payload" text NOT NULL,
        "attributionUrl" text,
        "fetchedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "refreshAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_video_metadata_source_record" PRIMARY KEY ("id"),
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

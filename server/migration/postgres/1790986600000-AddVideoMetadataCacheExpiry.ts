import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVideoMetadataCacheExpiry1790986600000 implements MigrationInterface {
  name = 'AddVideoMetadataCacheExpiry1790986600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn(
        'media_search_metadata',
        'videoMetadataExpiresAt'
      ))
    ) {
      await queryRunner.query(
        'ALTER TABLE "media_search_metadata" ADD COLUMN "videoMetadataExpiresAt" TIMESTAMP WITH TIME ZONE'
      );
    }
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_media_search_video_metadata_expires" ON "media_search_metadata" ("videoMetadataExpiresAt")'
    );
    await queryRunner.query(`
      UPDATE "media_search_metadata"
      SET "videoMetadataExpiresAt" = CASE
        WHEN "createdAt" <= CURRENT_TIMESTAMP - INTERVAL '6 months'
          THEN CURRENT_TIMESTAMP
        ELSE "createdAt" + INTERVAL '6 months'
      END
      WHERE lower(coalesce("format", '')) IN ('movie', 'series')
        AND (
          lower(coalesce("provider", '')) LIKE '%tmdb%'
          OR lower(coalesce("provider", '')) LIKE '%tvdb%'
          OR lower(coalesce("provider", '')) LIKE '%tvmaze%'
          OR lower(coalesce("provider", '')) LIKE '%wikidata%'
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "IDX_media_search_video_metadata_expires"'
    );
    if (
      await queryRunner.hasColumn(
        'media_search_metadata',
        'videoMetadataExpiresAt'
      )
    ) {
      await queryRunner.query(
        'ALTER TABLE "media_search_metadata" DROP COLUMN "videoMetadataExpiresAt"'
      );
    }
  }
}

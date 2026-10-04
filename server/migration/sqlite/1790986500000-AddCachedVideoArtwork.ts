import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCachedVideoArtwork1790986500000 implements MigrationInterface {
  name = 'AddCachedVideoArtwork1790986500000';

  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('media_search_metadata', 'overview'))) {
      await runner.query(
        'ALTER TABLE "media_search_metadata" ADD COLUMN "overview" text'
      );
    }
    if (!(await runner.hasColumn('media_search_metadata', 'posterPath'))) {
      await runner.query(
        'ALTER TABLE "media_search_metadata" ADD COLUMN "posterPath" text'
      );
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    if (await runner.hasColumn('media_search_metadata', 'posterPath')) {
      await runner.query(
        'ALTER TABLE "media_search_metadata" DROP COLUMN "posterPath"'
      );
    }
    if (await runner.hasColumn('media_search_metadata', 'overview')) {
      await runner.query(
        'ALTER TABLE "media_search_metadata" DROP COLUMN "overview"'
      );
    }
  }
}

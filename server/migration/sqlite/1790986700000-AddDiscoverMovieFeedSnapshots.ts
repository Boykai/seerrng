import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDiscoverMovieFeedSnapshots1790986700000 implements MigrationInterface {
  name = 'AddDiscoverMovieFeedSnapshots1790986700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "discover_movie_feed_snapshot" (
        "cacheKey" varchar(64) PRIMARY KEY NOT NULL,
        "payload" text NOT NULL,
        "fetchedAt" datetime NOT NULL
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "IDX_discover_movie_feed_snapshot_fetched" ON "discover_movie_feed_snapshot" ("fetchedAt")'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "discover_movie_feed_snapshot"');
  }
}

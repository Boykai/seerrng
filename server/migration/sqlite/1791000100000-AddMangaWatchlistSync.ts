import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaWatchlistSync1791000100000 implements MigrationInterface {
  name = 'AddMangaWatchlistSync1791000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('user_settings', 'watchlistSyncManga'))) {
      await queryRunner.query(
        `ALTER TABLE "user_settings" ADD "watchlistSyncManga" boolean`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('user_settings', 'watchlistSyncManga')) {
      await queryRunner.query(
        `ALTER TABLE "user_settings" DROP COLUMN "watchlistSyncManga"`
      );
    }
  }
}

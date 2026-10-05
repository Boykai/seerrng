import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaCardTextVisibility1791000230000 implements MigrationInterface {
  name = 'AddMangaCardTextVisibility1791000230000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "cardTextVisibilityManga" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "cardTextVisibilityManga"`
    );
  }
}

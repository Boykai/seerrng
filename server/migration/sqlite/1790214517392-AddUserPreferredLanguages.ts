import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserPreferredLanguages1790214517392 implements MigrationInterface {
  name = 'AddUserPreferredLanguages1790214517392';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('user_settings', 'preferredLanguages'))) {
      await queryRunner.query(
        `ALTER TABLE "user_settings" ADD "preferredLanguages" text`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('user_settings', 'preferredLanguages')) {
      await queryRunner.query(
        `ALTER TABLE "user_settings" DROP COLUMN "preferredLanguages"`
      );
    }
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaFilterPins1790100000000 implements MigrationInterface {
  name = 'AddMediaFilterPins1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('user_settings', 'mediaFilterPins'))) {
      await queryRunner.query(
        'ALTER TABLE "user_settings" ADD COLUMN "mediaFilterPins" text'
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('user_settings', 'mediaFilterPins')) {
      await queryRunner.query(
        'ALTER TABLE "user_settings" DROP COLUMN "mediaFilterPins"'
      );
    }
  }
}

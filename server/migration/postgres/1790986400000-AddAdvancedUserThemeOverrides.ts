import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdvancedUserThemeOverrides1790986400000 implements MigrationInterface {
  name = 'AddAdvancedUserThemeOverrides1790986400000';

  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('user_settings', 'advancedThemeOverrides'))) {
      await runner.query(
        'ALTER TABLE "user_settings" ADD COLUMN "advancedThemeOverrides" text'
      );
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    if (await runner.hasColumn('user_settings', 'advancedThemeOverrides')) {
      await runner.query(
        'ALTER TABLE "user_settings" DROP COLUMN "advancedThemeOverrides"'
      );
    }
  }
}

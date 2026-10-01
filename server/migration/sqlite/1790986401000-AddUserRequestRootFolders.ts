import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserRequestRootFolders1790986401000 implements MigrationInterface {
  name = 'AddUserRequestRootFolders1790986401000';

  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('user_settings', 'requestRootFolders'))) {
      await runner.query(
        'ALTER TABLE "user_settings" ADD COLUMN "requestRootFolders" text'
      );
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    if (await runner.hasColumn('user_settings', 'requestRootFolders')) {
      await runner.query(
        'ALTER TABLE "user_settings" DROP COLUMN "requestRootFolders"'
      );
    }
  }
}

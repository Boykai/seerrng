import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAnilistPlanningImport1791000110000 implements MigrationInterface {
  name = 'AddAnilistPlanningImport1791000110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn('discovery_account', 'importMangaPlanning'))
    ) {
      await queryRunner.query(
        `ALTER TABLE "discovery_account" ADD "importMangaPlanning" boolean NOT NULL DEFAULT (0)`
      );
    }
    if (
      !(await queryRunner.hasColumn('discovery_account', 'mangaPlanningCursor'))
    ) {
      await queryRunner.query(
        `ALTER TABLE "discovery_account" ADD "mangaPlanningCursor" integer`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of ['mangaPlanningCursor', 'importMangaPlanning']) {
      if (await queryRunner.hasColumn('discovery_account', column)) {
        await queryRunner.query(
          `ALTER TABLE "discovery_account" DROP COLUMN "${column}"`
        );
      }
    }
  }
}

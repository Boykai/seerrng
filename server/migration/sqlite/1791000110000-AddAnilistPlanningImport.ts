import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS = [
  ['importMangaPlanning', 'boolean NOT NULL DEFAULT (0)'],
  ['mangaPlanningCursor', 'integer'],
  ['mangaPlanningCursorId', 'integer'],
] as const;

export class AddAnilistPlanningImport1791000110000 implements MigrationInterface {
  name = 'AddAnilistPlanningImport1791000110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [column, definition] of COLUMNS) {
      if (!(await queryRunner.hasColumn('discovery_account', column))) {
        await queryRunner.query(
          `ALTER TABLE "discovery_account" ADD "${column}" ${definition}`
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [column] of [...COLUMNS].reverse()) {
      if (await queryRunner.hasColumn('discovery_account', column)) {
        await queryRunner.query(
          `ALTER TABLE "discovery_account" DROP COLUMN "${column}"`
        );
      }
    }
  }
}

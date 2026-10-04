import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAnilistPlanningImport1791000110000 implements MigrationInterface {
  name = 'AddAnilistPlanningImport1791000110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "discovery_account" ADD "importMangaPlanning" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(
      `ALTER TABLE "discovery_account" ADD "mangaPlanningCursor" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "discovery_account" ADD "mangaPlanningCursorId" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "discovery_account" DROP COLUMN "mangaPlanningCursorId"`
    );
    await queryRunner.query(
      `ALTER TABLE "discovery_account" DROP COLUMN "mangaPlanningCursor"`
    );
    await queryRunner.query(
      `ALTER TABLE "discovery_account" DROP COLUMN "importMangaPlanning"`
    );
  }
}

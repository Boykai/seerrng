import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBookOverrideRules1790200000000 implements MigrationInterface {
  name = 'AddBookOverrideRules1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD "readarrServiceId" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "readarrServiceId"`
    );
  }
}

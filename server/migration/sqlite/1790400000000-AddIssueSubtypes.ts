import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIssueSubtypes1790400000000 implements MigrationInterface {
  name = 'AddIssueSubtypes1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "issue" ADD COLUMN "issueSubtype" varchar(64)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "issue" DROP COLUMN "issueSubtype"`);
  }
}

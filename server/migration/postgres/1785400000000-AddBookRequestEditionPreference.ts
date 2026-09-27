import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBookRequestEditionPreference1785400000000 implements MigrationInterface {
  name = 'AddBookRequestEditionPreference1785400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('media_request', 'preferredEditionId'))) {
      await queryRunner.query(
        `ALTER TABLE "media_request" ADD "preferredEditionId" character varying`
      );
    }
    if (!(await queryRunner.hasColumn('media_request', 'preferredIsbn13'))) {
      await queryRunner.query(
        `ALTER TABLE "media_request" ADD "preferredIsbn13" character varying`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('media_request', 'preferredIsbn13')) {
      await queryRunner.query(
        `ALTER TABLE "media_request" DROP COLUMN "preferredIsbn13"`
      );
    }
    if (await queryRunner.hasColumn('media_request', 'preferredEditionId')) {
      await queryRunner.query(
        `ALTER TABLE "media_request" DROP COLUMN "preferredEditionId"`
      );
    }
  }
}

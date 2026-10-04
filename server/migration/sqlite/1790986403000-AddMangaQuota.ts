import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaQuota1790986403000 implements MigrationInterface {
  name = 'AddMangaQuota1790986403000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('user', 'mangaQuotaLimit'))) {
      await queryRunner.query(
        `ALTER TABLE "user" ADD "mangaQuotaLimit" integer`
      );
    }
    if (!(await queryRunner.hasColumn('user', 'mangaQuotaDays'))) {
      await queryRunner.query(
        `ALTER TABLE "user" ADD "mangaQuotaDays" integer`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('user', 'mangaQuotaDays')) {
      await queryRunner.query(
        `ALTER TABLE "user" DROP COLUMN "mangaQuotaDays"`
      );
    }
    if (await queryRunner.hasColumn('user', 'mangaQuotaLimit')) {
      await queryRunner.query(
        `ALTER TABLE "user" DROP COLUMN "mangaQuotaLimit"`
      );
    }
  }
}

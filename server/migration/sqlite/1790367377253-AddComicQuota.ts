import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddComicQuota1790367377253 implements MigrationInterface {
  name = 'AddComicQuota1790367377253';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('user', 'comicQuotaLimit'))) {
      await queryRunner.query(
        `ALTER TABLE "user" ADD "comicQuotaLimit" integer`
      );
    }
    if (!(await queryRunner.hasColumn('user', 'comicQuotaDays'))) {
      await queryRunner.query(
        `ALTER TABLE "user" ADD "comicQuotaDays" integer`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('user', 'comicQuotaDays')) {
      await queryRunner.query(
        `ALTER TABLE "user" DROP COLUMN "comicQuotaDays"`
      );
    }
    if (await queryRunner.hasColumn('user', 'comicQuotaLimit')) {
      await queryRunner.query(
        `ALTER TABLE "user" DROP COLUMN "comicQuotaLimit"`
      );
    }
  }
}

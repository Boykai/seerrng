import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaQuota1790986403000 implements MigrationInterface {
  name = 'AddMangaQuota1790986403000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ADD "mangaQuotaLimit" integer`);
    await queryRunner.query(`ALTER TABLE "user" ADD "mangaQuotaDays" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "mangaQuotaDays"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "mangaQuotaLimit"`);
  }
}

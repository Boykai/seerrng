import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddComicServiceType1790306190792 implements MigrationInterface {
  name = 'AddComicServiceType1790306190792';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('media', 'comicServiceType'))) {
      await queryRunner.query(
        `ALTER TABLE "media" ADD "comicServiceType" varchar`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('media', 'comicServiceType')) {
      await queryRunner.query(
        `ALTER TABLE "media" DROP COLUMN "comicServiceType"`
      );
    }
  }
}

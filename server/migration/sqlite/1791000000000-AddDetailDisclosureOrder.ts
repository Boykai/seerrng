import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AddDetailDisclosureOrder1791000000000 implements MigrationInterface {
  name = 'AddDetailDisclosureOrder1791000000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "user_settings" ADD COLUMN "detailDisclosureOrder" text'
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "user_settings" DROP COLUMN "detailDisclosureOrder"'
    );
  }
}

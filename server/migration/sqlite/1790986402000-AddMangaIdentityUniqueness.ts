import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMangaIdentityUniqueness1790986402000 implements MigrationInterface {
  name = 'AddMangaIdentityUniqueness1790986402000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_media_identifier_canonical_manga" ON "media_identifier" ("provider", "value") WHERE "provider" = 'anilist'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_media_identifier_canonical_manga"`
    );
  }
}

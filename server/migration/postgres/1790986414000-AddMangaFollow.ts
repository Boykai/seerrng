import type { MigrationInterface, QueryRunner } from 'typeorm';

const MANIFEST_COLUMNS = [
  ['followEnabled', 'boolean NOT NULL DEFAULT false'],
  ['followNextAt', 'TIMESTAMP WITH TIME ZONE'],
  ['followLastAt', 'TIMESTAMP WITH TIME ZONE'],
  ['followStopReason', 'character varying(64)'],
] as const;

const CHAPTER_COLUMNS = [
  ['followAddedAt', 'TIMESTAMP WITH TIME ZONE'],
] as const;

const TABLES = [
  ['manga_request_manifest', MANIFEST_COLUMNS],
  ['manga_request_chapter', CHAPTER_COLUMNS],
] as const;

export class AddMangaFollow1790986414000 implements MigrationInterface {
  name = 'AddMangaFollow1790986414000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, columns] of TABLES) {
      for (const [column, type] of columns) {
        await queryRunner.query(
          `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${type}`
        );
      }
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_manga_request_manifest_follow_due" ON "manga_request_manifest" ("followEnabled", "followNextAt")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_manga_request_manifest_follow_due"`
    );
    for (const [table, columns] of [...TABLES].reverse()) {
      for (const [column] of [...columns].reverse()) {
        await queryRunner.query(
          `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`
        );
      }
    }
  }
}

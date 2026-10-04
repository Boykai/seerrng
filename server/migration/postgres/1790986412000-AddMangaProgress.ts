import type { MigrationInterface, QueryRunner } from 'typeorm';

const MANIFEST_COLUMNS = [
  ['attentionCode', 'character varying(64)'],
  ['attentionAt', 'TIMESTAMP WITH TIME ZONE'],
  ['progressAt', 'TIMESTAMP WITH TIME ZONE'],
  ['progressSignature', 'character varying(64)'],
  ['chaptersTotal', 'integer NOT NULL DEFAULT 0'],
  ['chaptersVerified', 'integer NOT NULL DEFAULT 0'],
  ['chaptersQueued', 'integer NOT NULL DEFAULT 0'],
  ['chaptersDownloading', 'integer NOT NULL DEFAULT 0'],
  ['chaptersErrored', 'integer NOT NULL DEFAULT 0'],
  ['chaptersMissing', 'integer NOT NULL DEFAULT 0'],
] as const;

const CHAPTER_COLUMNS = [
  ['deliverableAt', 'TIMESTAMP WITH TIME ZONE'],
  ['lastQueueState', 'character varying(16)'],
  ['missingSince', 'TIMESTAMP WITH TIME ZONE'],
  ['fileState', 'character varying(16)'],
  ['headCheckedAt', 'TIMESTAMP WITH TIME ZONE'],
] as const;

const TABLES = [
  ['manga_request_manifest', MANIFEST_COLUMNS],
  ['manga_request_chapter', CHAPTER_COLUMNS],
] as const;

export class AddMangaProgress1790986412000 implements MigrationInterface {
  name = 'AddMangaProgress1790986412000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, columns] of TABLES) {
      for (const [column, type] of columns) {
        await queryRunner.query(
          `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${type}`
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, columns] of [...TABLES].reverse()) {
      for (const [column] of [...columns].reverse()) {
        await queryRunner.query(
          `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`
        );
      }
    }
  }
}

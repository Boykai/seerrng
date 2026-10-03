import type { MigrationInterface, QueryRunner } from 'typeorm';

const MANIFEST_COLUMNS = [
  ['attentionCode', 'varchar(64)'],
  ['attentionAt', 'datetime'],
  ['progressAt', 'datetime'],
  ['progressSignature', 'varchar(64)'],
  ['chaptersTotal', 'integer NOT NULL DEFAULT (0)'],
  ['chaptersVerified', 'integer NOT NULL DEFAULT (0)'],
  ['chaptersQueued', 'integer NOT NULL DEFAULT (0)'],
  ['chaptersDownloading', 'integer NOT NULL DEFAULT (0)'],
  ['chaptersErrored', 'integer NOT NULL DEFAULT (0)'],
  ['chaptersMissing', 'integer NOT NULL DEFAULT (0)'],
] as const;

const CHAPTER_COLUMNS = [
  ['deliverableAt', 'datetime'],
  ['lastQueueState', 'varchar(16)'],
  ['missingSince', 'datetime'],
  ['fileState', 'varchar(16)'],
  ['headCheckedAt', 'datetime'],
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
        if (!(await queryRunner.hasColumn(table, column))) {
          await queryRunner.query(
            `ALTER TABLE "${table}" ADD "${column}" ${type}`
          );
        }
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, columns] of [...TABLES].reverse()) {
      for (const [column] of [...columns].reverse()) {
        if (await queryRunner.hasColumn(table, column)) {
          await queryRunner.query(
            `ALTER TABLE "${table}" DROP COLUMN "${column}"`
          );
        }
      }
    }
  }
}

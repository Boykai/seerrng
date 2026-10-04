import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS: readonly (readonly [name: string, type: string])[] = [
  ['malId', 'integer'],
  ['malCheckedAt', 'datetime'],
  ['mangadexCheckedAt', 'datetime'],
  ['titleCheckedAt', 'datetime'],
  ['proposedAnilistId', 'integer'],
  ['proposalConfidence', 'varchar(16)'],
  ['proposalScore', 'integer'],
];

export class AddMangaMatchProposals1790986405000 implements MigrationInterface {
  name = 'AddMangaMatchProposals1790986405000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, type] of COLUMNS) {
      if (!(await queryRunner.hasColumn('manga_match_candidate', name))) {
        await queryRunner.query(
          `ALTER TABLE "manga_match_candidate" ADD "${name}" ${type}`
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of [...COLUMNS].reverse()) {
      if (await queryRunner.hasColumn('manga_match_candidate', name)) {
        await queryRunner.query(
          `ALTER TABLE "manga_match_candidate" DROP COLUMN "${name}"`
        );
      }
    }
  }
}

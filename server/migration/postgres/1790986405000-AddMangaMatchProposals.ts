import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS: readonly (readonly [name: string, type: string])[] = [
  ['malId', 'integer'],
  ['malCheckedAt', 'TIMESTAMP WITH TIME ZONE'],
  ['mangadexCheckedAt', 'TIMESTAMP WITH TIME ZONE'],
  ['titleCheckedAt', 'TIMESTAMP WITH TIME ZONE'],
  ['proposedAnilistId', 'integer'],
  ['proposalConfidence', 'character varying(16)'],
  ['proposalScore', 'integer'],
];

export class AddMangaMatchProposals1790986405000 implements MigrationInterface {
  name = 'AddMangaMatchProposals1790986405000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, type] of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "manga_match_candidate" ADD "${name}" ${type}`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of [...COLUMNS].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "manga_match_candidate" DROP COLUMN "${name}"`
      );
    }
  }
}

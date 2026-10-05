import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryRunner } from 'typeorm';
import { AddMangaCardTextVisibility1791000230000 } from './1791000230000-AddMangaCardTextVisibility';

test('PostgreSQL manga card text migration only adds and drops one nullable column', async () => {
  const migration = new AddMangaCardTextVisibility1791000230000();
  const statements: string[] = [];
  const queryRunner = {
    query: async (statement: string) => {
      statements.push(statement);
    },
  } as QueryRunner;

  await migration.up(queryRunner);
  await migration.down(queryRunner);

  assert.equal(migration.name, 'AddMangaCardTextVisibility1791000230000');
  assert.deepStrictEqual(statements, [
    `ALTER TABLE "user_settings" ADD "cardTextVisibilityManga" character varying`,
    `ALTER TABLE "user_settings" DROP COLUMN "cardTextVisibilityManga"`,
  ]);
});

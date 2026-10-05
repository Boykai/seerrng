import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { CreateGameLibrary1791020000000 } from './1791020000000-CreateGameLibrary';

test('creates private game-library entries and unique Steam account links', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new CreateGameLibrary1791020000000();

  try {
    await queryRunner.query(
      'CREATE TABLE "user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)'
    );
    await queryRunner.query('INSERT INTO "user" ("id") VALUES (1)');
    await migration.up(queryRunner);

    assert.equal(await queryRunner.hasTable('game_library_entry'), true);
    assert.equal(await queryRunner.hasTable('game_library_account'), true);
    const indexNames = (
      await queryRunner.query(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'index'`
      )
    ).map((row: { name: string }) => row.name);
    assert.ok(indexNames.includes('IDX_game_library_entry_user_key'));
    assert.ok(indexNames.includes('IDX_game_library_account_steam_id'));

    await queryRunner.query(`
      INSERT INTO "game_library_entry" ("userId", "externalKey", "category", "title")
      VALUES (1, 'steam:10', 'game', 'Private Game')
    `);
    const [entry] = await queryRunner.query(
      'SELECT "status", "isOwned", "steamOwned", "shareWithHousehold", "source" FROM "game_library_entry"'
    );
    assert.deepEqual(entry, {
      status: 'backlog',
      isOwned: 0,
      steamOwned: 0,
      shareWithHousehold: 0,
      source: 'manual',
    });

    await assert.rejects(
      queryRunner.query(`
        INSERT INTO "game_library_entry" ("userId", "externalKey", "category", "title")
        VALUES (1, 'steam:10', 'game', 'Duplicate')
      `)
    );

    await queryRunner.query(`
      INSERT INTO "game_library_account" ("userId", "steamId")
      VALUES (1, '76561198000000001')
    `);
    await assert.rejects(
      queryRunner.query(`
        INSERT INTO "game_library_account" ("userId", "steamId")
        VALUES (1, '76561198000000002')
      `)
    );

    await migration.down(queryRunner);
    assert.equal(await queryRunner.hasTable('game_library_account'), false);
    assert.equal(await queryRunner.hasTable('game_library_entry'), false);
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

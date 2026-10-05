import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateGameLibrary1791020000000 implements MigrationInterface {
  name = 'CreateGameLibrary1791020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "game_library_entry" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "userId" integer NOT NULL,
        "externalKey" varchar(80) NOT NULL,
        "catalogId" integer,
        "category" varchar(8) NOT NULL,
        "title" varchar(512) NOT NULL,
        "summary" text NOT NULL DEFAULT '',
        "coverUrl" varchar(2048) NOT NULL DEFAULT '',
        "releaseDate" varchar(32) NOT NULL DEFAULT '',
        "status" varchar(16) NOT NULL DEFAULT 'backlog',
        "isOwned" boolean NOT NULL DEFAULT 0,
        "steamAppId" integer,
        "steamOwned" boolean NOT NULL DEFAULT 0,
        "playtimeMinutes" integer NOT NULL DEFAULT 0,
        "storeName" varchar(120) NOT NULL DEFAULT '',
        "platformName" varchar(120) NOT NULL DEFAULT '',
        "shareWithHousehold" boolean NOT NULL DEFAULT 0,
        "source" varchar(8) NOT NULL DEFAULT 'manual',
        "lastSyncedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "FK_game_library_entry_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "IDX_game_library_entry_user_key" ON "game_library_entry" ("userId", "externalKey")'
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_game_library_entry_user_catalog" ON "game_library_entry" ("userId", "catalogId")'
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_game_library_entry_household" ON "game_library_entry" ("shareWithHousehold", "catalogId", "steamAppId")'
    );

    await queryRunner.query(`
      CREATE TABLE "game_library_account" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "userId" integer NOT NULL,
        "steamId" varchar(20) NOT NULL,
        "profileName" varchar(128) NOT NULL DEFAULT '',
        "lastSyncCount" integer NOT NULL DEFAULT 0,
        "lastSyncedAt" datetime,
        "linkedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "FK_game_library_account_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "IDX_game_library_account_user" ON "game_library_account" ("userId")'
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX "IDX_game_library_account_steam_id" ON "game_library_account" ("steamId")'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "game_library_account"');
    await queryRunner.query('DROP TABLE "game_library_entry"');
  }
}

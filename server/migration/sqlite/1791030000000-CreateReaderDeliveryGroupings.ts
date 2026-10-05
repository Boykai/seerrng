import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReaderDeliveryGroupings1791030000000 implements MigrationInterface {
  name = 'CreateReaderDeliveryGroupings1791030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "reader_delivery_grouping" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "provider" varchar(16) NOT NULL,
        "targetType" varchar(16) NOT NULL,
        "targetId" varchar(255) NOT NULL,
        "targetName" varchar(255) NOT NULL,
        "groupName" varchar(320) NOT NULL,
        "remoteGroupId" varchar(255),
        "isPublic" boolean NOT NULL DEFAULT 1,
        "syncToKobo" boolean NOT NULL DEFAULT 0,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "lastMatchCount" integer NOT NULL DEFAULT 0,
        "countVerified" boolean NOT NULL DEFAULT 0,
        "lastError" varchar(512),
        "lastSyncedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "IDX_reader_delivery_grouping_identity" ON "reader_delivery_grouping" ("provider", "targetType", "targetId")'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "reader_delivery_grouping"');
  }
}

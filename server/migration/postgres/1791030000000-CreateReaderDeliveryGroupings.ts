import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReaderDeliveryGroupings1791030000000 implements MigrationInterface {
  name = 'CreateReaderDeliveryGroupings1791030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "reader_delivery_grouping" (
        "id" SERIAL NOT NULL,
        "provider" character varying(16) NOT NULL,
        "targetType" character varying(16) NOT NULL,
        "targetId" character varying(255) NOT NULL,
        "targetName" character varying(255) NOT NULL,
        "groupName" character varying(320) NOT NULL,
        "remoteGroupId" character varying(255),
        "isPublic" boolean NOT NULL DEFAULT true,
        "syncToKobo" boolean NOT NULL DEFAULT false,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "lastMatchCount" integer NOT NULL DEFAULT 0,
        "countVerified" boolean NOT NULL DEFAULT false,
        "lastError" character varying(512),
        "lastSyncedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reader_delivery_grouping" PRIMARY KEY ("id")
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

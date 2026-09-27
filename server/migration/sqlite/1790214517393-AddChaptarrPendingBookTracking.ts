import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChaptarrPendingBookTracking1790214517393 implements MigrationInterface {
  name = 'AddChaptarrPendingBookTracking1790214517393';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const currentTable = await queryRunner.getTable('book_request_search');
    const hasTargetSchema =
      ['providerBookId', 'providerEditionId', 'pendingId'].every((name) =>
        currentTable?.findColumnByName(name)
      ) &&
      currentTable?.findColumnByName('bookId')?.isNullable === true &&
      currentTable?.findColumnByName('commandId')?.isNullable === true;
    if (hasTargetSchema) {
      return;
    }

    await queryRunner.query(`
      CREATE TABLE "book_request_search_v2" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "requestId" integer NOT NULL,
        "serviceId" integer NOT NULL,
        "format" varchar(16) NOT NULL,
        "bookId" integer,
        "providerBookId" varchar(512),
        "providerEditionId" varchar(512),
        "pendingId" integer,
        "authorId" integer,
        "commandId" integer,
        "createdBook" boolean NOT NULL DEFAULT (0),
        "createdAuthor" boolean NOT NULL DEFAULT (0),
        "state" varchar(32) NOT NULL DEFAULT ('searching'),
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "UQ_book_request_search_request_format"
          UNIQUE ("requestId", "format"),
        CONSTRAINT "FK_book_request_search_request"
          FOREIGN KEY ("requestId") REFERENCES "media_request" ("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      INSERT INTO "book_request_search_v2" (
        "id", "requestId", "serviceId", "format", "bookId", "authorId",
        "commandId", "createdBook", "createdAuthor", "state", "createdAt",
        "updatedAt"
      )
      SELECT
        "id", "requestId", "serviceId", "format", "bookId", "authorId",
        "commandId", "createdBook", "createdAuthor", "state", "createdAt",
        "updatedAt"
      FROM "book_request_search"
    `);
    await queryRunner.query('DROP INDEX "IDX_book_request_search_command"');
    await queryRunner.query('DROP TABLE "book_request_search"');
    await queryRunner.query(
      'ALTER TABLE "book_request_search_v2" RENAME TO "book_request_search"'
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_book_request_search_command" ON "book_request_search" ("serviceId", "commandId")'
    );
    await queryRunner.query(`
      UPDATE "book_request_search"
      SET "providerBookId" = (
        SELECT "media_identifier"."value"
        FROM "media_identifier"
        INNER JOIN "media" ON "media"."id" = "media_identifier"."mediaId"
        INNER JOIN "media_request" ON "media_request"."mediaId" = "media"."id"
        WHERE "media_request"."id" = "book_request_search"."requestId"
          AND "media_identifier"."provider" = 'readarr'
        ORDER BY "media_identifier"."id" ASC
        LIMIT 1
      )
      WHERE "providerBookId" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "book_request_search_v1" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "requestId" integer NOT NULL,
        "serviceId" integer NOT NULL,
        "format" varchar(16) NOT NULL,
        "bookId" integer NOT NULL,
        "authorId" integer,
        "commandId" integer NOT NULL,
        "createdBook" boolean NOT NULL DEFAULT (0),
        "createdAuthor" boolean NOT NULL DEFAULT (0),
        "state" varchar(32) NOT NULL DEFAULT ('searching'),
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "UQ_book_request_search_request_format"
          UNIQUE ("requestId", "format"),
        CONSTRAINT "FK_book_request_search_request"
          FOREIGN KEY ("requestId") REFERENCES "media_request" ("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      INSERT INTO "book_request_search_v1" (
        "id", "requestId", "serviceId", "format", "bookId", "authorId",
        "commandId", "createdBook", "createdAuthor", "state", "createdAt",
        "updatedAt"
      )
      SELECT
        "id", "requestId", "serviceId", "format", "bookId", "authorId",
        "commandId", "createdBook", "createdAuthor", "state", "createdAt",
        "updatedAt"
      FROM "book_request_search"
      WHERE "bookId" IS NOT NULL AND "commandId" IS NOT NULL
    `);
    await queryRunner.query('DROP INDEX "IDX_book_request_search_command"');
    await queryRunner.query('DROP TABLE "book_request_search"');
    await queryRunner.query(
      'ALTER TABLE "book_request_search_v1" RENAME TO "book_request_search"'
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_book_request_search_command" ON "book_request_search" ("serviceId", "commandId")'
    );
  }
}

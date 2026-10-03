import assert from 'node:assert/strict';
import test from 'node:test';

import { AddMangaIdentityUniqueness1790986402000 as PortableMangaIdentityMigration } from '@server/migration/sqlite/1790986402000-AddMangaIdentityUniqueness';
import { AddMangaLibraryBindings1790986404000 as PortableMangaLibraryMigration } from '@server/migration/sqlite/1790986404000-AddMangaLibraryBindings';
import { DataSource, type QueryRunner } from 'typeorm';
import { AddMangaIdentityUniqueness1790986402000 } from './1790986402000-AddMangaIdentityUniqueness';
import { AddMangaQuota1790986403000 } from './1790986403000-AddMangaQuota';
import { AddMangaLibraryBindings1790986404000 } from './1790986404000-AddMangaLibraryBindings';

const postgresUrl = process.env.SEERR_TEST_POSTGRES_URL;
const postgresTest = postgresUrl ? test : test.skip;

const recordStatements = async (
  run: (queryRunner: QueryRunner) => Promise<void>
) => {
  const statements: string[] = [];
  const queryRunner = {
    query: async (statement: string) => {
      statements.push(statement);
    },
  } as QueryRunner;
  await run(queryRunner);
  return statements;
};

test('PostgreSQL manga identity migration reuses the portable statements under its own name', async () => {
  const migration = new AddMangaIdentityUniqueness1790986402000();
  const portable = new PortableMangaIdentityMigration();

  assert.equal(migration.name, 'AddMangaIdentityUniqueness1790986402000');
  assert.deepStrictEqual(
    await recordStatements(async (queryRunner) => {
      await migration.up(queryRunner);
      await migration.down(queryRunner);
    }),
    await recordStatements(async (queryRunner) => {
      await portable.up(queryRunner);
      await portable.down(queryRunner);
    })
  );
});

test('PostgreSQL manga quota migration adds and drops both columns', async () => {
  const migration = new AddMangaQuota1790986403000();

  assert.deepStrictEqual(
    await recordStatements(async (queryRunner) => {
      await migration.up(queryRunner);
      await migration.down(queryRunner);
    }),
    [
      `ALTER TABLE "user" ADD "mangaQuotaLimit" integer`,
      `ALTER TABLE "user" ADD "mangaQuotaDays" integer`,
      `ALTER TABLE "user" DROP COLUMN "mangaQuotaDays"`,
      `ALTER TABLE "user" DROP COLUMN "mangaQuotaLimit"`,
    ]
  );
});

test('PostgreSQL manga library migration creates the SQLite indexes and drops both tables', async () => {
  const migration = new AddMangaLibraryBindings1790986404000();
  const indexes = (statements: string[]) =>
    statements.filter((statement) => / INDEX /.test(statement));
  const postgres = await recordStatements((queryRunner) =>
    migration.up(queryRunner)
  );

  assert.equal(migration.name, 'AddMangaLibraryBindings1790986404000');
  assert.equal(indexes(postgres).length, 4);
  assert.deepStrictEqual(
    indexes(postgres),
    indexes(
      await recordStatements((queryRunner) =>
        new PortableMangaLibraryMigration().up(queryRunner)
      )
    )
  );
  assert.deepStrictEqual(
    await recordStatements((queryRunner) => migration.down(queryRunner)),
    [
      `DROP TABLE IF EXISTS "manga_match_candidate"`,
      `DROP TABLE IF EXISTS "manga_source_binding"`,
    ]
  );
});

// Temporary tables shadow any real tables for this session only, and the
// transaction is always rolled back, so these tests never change the database.
const withPostgresQueryRunner = async (
  callback: (queryRunner: QueryRunner) => Promise<void>
) => {
  const dataSource = await new DataSource({
    type: 'postgres',
    url: postgresUrl,
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    await callback(queryRunner);
  } finally {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    await queryRunner.release();
    await dataSource.destroy();
  }
};

postgresTest(
  'PostgreSQL manga identity migration enforces one AniList owner reversibly',
  async () => {
    await withPostgresQueryRunner(async (queryRunner) => {
      await queryRunner.query(
        `CREATE TEMPORARY TABLE "media_identifier" (
          "id" integer PRIMARY KEY,
          "mediaId" integer,
          "provider" varchar NOT NULL,
          "value" varchar NOT NULL
        )`
      );
      const insertIdentifier = (
        id: number,
        mediaId: number,
        provider: string,
        value: string
      ) =>
        queryRunner.query(
          `INSERT INTO "media_identifier" ("id", "mediaId", "provider", "value")
           VALUES ($1, $2, $3, $4)`,
          [id, mediaId, provider, value]
        );
      const mangaIndexDefinitions = async () =>
        (
          (await queryRunner.query(
            `SELECT pg_get_indexdef(i."indexrelid") AS "definition"
             FROM pg_index i
             JOIN pg_class c ON c."oid" = i."indexrelid"
             WHERE i."indrelid" = 'pg_temp.media_identifier'::regclass
               AND c."relname" = 'UQ_media_identifier_canonical_manga'`
          )) as { definition: string }[]
        ).map(({ definition }) => definition);
      await insertIdentifier(1, 1, 'anilist', '30013');

      const migration = new AddMangaIdentityUniqueness1790986402000();
      await migration.up(queryRunner);
      await migration.up(queryRunner);

      const [definition, ...extra] = await mangaIndexDefinitions();
      assert.deepStrictEqual(extra, []);
      assert.match(definition, /^CREATE UNIQUE INDEX /);
      assert.match(definition, /\(provider, value\)/);
      assert.match(definition, /WHERE .*provider.*'anilist'/);

      await queryRunner.query('SAVEPOINT manga_identity_unique_check');
      await assert.rejects(
        insertIdentifier(2, 2, 'anilist', '30013'),
        /unique/i
      );
      await queryRunner.query(
        'ROLLBACK TO SAVEPOINT manga_identity_unique_check'
      );

      // Cross-reference providers stay non-unique: several titles can share them.
      await insertIdentifier(3, 1, 'mangadex', 'shared');
      await insertIdentifier(4, 2, 'mangadex', 'shared');
      await insertIdentifier(5, 1, 'mal', '13');
      await insertIdentifier(6, 2, 'mal', '13');
      await insertIdentifier(7, 1, 'mangaupdates', 'series');
      await insertIdentifier(8, 2, 'mangaupdates', 'series');

      await migration.down(queryRunner);
      await migration.down(queryRunner);

      assert.deepStrictEqual(await mangaIndexDefinitions(), []);
      await insertIdentifier(9, 3, 'anilist', '30013');
    });
  }
);

postgresTest(
  'PostgreSQL manga quota migration adds nullable integer columns reversibly',
  async () => {
    await withPostgresQueryRunner(async (queryRunner) => {
      await queryRunner.query(
        `CREATE TEMPORARY TABLE "user" (
          "id" integer PRIMARY KEY,
          "email" varchar NOT NULL
        )`
      );
      await queryRunner.query(
        `INSERT INTO "user" ("id", "email") VALUES (1, 'reader@example.com')`
      );
      const mangaColumns = async () =>
        queryRunner.query(
          `SELECT a."attname" AS "name",
                  format_type(a."atttypid", a."atttypmod") AS "type",
                  a."attnotnull" AS "notNull"
           FROM pg_attribute a
           WHERE a."attrelid" = 'pg_temp."user"'::regclass
             AND a."attnum" > 0
             AND NOT a."attisdropped"
             AND a."attname" LIKE 'manga%'
           ORDER BY a."attnum"`
        );

      const migration = new AddMangaQuota1790986403000();
      await migration.up(queryRunner);

      assert.deepStrictEqual(await mangaColumns(), [
        { name: 'mangaQuotaLimit', type: 'integer', notNull: false },
        { name: 'mangaQuotaDays', type: 'integer', notNull: false },
      ]);
      assert.deepStrictEqual(
        await queryRunner.query(
          `SELECT "mangaQuotaLimit", "mangaQuotaDays" FROM "user"`
        ),
        [{ mangaQuotaLimit: null, mangaQuotaDays: null }]
      );

      await migration.down(queryRunner);

      assert.deepStrictEqual(await mangaColumns(), []);
      assert.deepStrictEqual(
        await queryRunner.query(`SELECT "id" FROM "user"`),
        [{ id: 1 }]
      );
    });
  }
);

postgresTest(
  'PostgreSQL manga library migration enforces live and pair uniqueness reversibly',
  async () => {
    await withPostgresQueryRunner(async (queryRunner) => {
      // The migrated database already has these tables; a private schema
      // keeps them out of reach, and the rollback removes it again.
      await queryRunner.query(`CREATE SCHEMA "manga_library_check"`);
      await queryRunner.query(`SET LOCAL search_path TO "manga_library_check"`);
      const objects = async () =>
        (
          (await queryRunner.query(
            `SELECT c."relkind" AS "kind", c."relname" AS "name"
             FROM pg_class c
             JOIN pg_namespace n ON n."oid" = c."relnamespace"
             WHERE n."nspname" = 'manga_library_check'
               AND c."relkind" IN ('r', 'i')
             ORDER BY c."relkind", c."relname"`
          )) as { kind: string; name: string }[]
        ).map(({ kind, name }) => `${kind} ${name}`);
      const insertBinding = (
        item: string,
        anilistId: number,
        state: string,
        instanceId = 1
      ) =>
        queryRunner.query(
          `INSERT INTO "manga_source_binding" ("instanceId", "sourceId", "url", "urlHash", "anilistId", "confidence", "matchedBy", "origin", "state")
           VALUES ($1, '0', $2, $3, $4, 'TRACKER_LINK', 'anilist-tracker', 'library-scan', $5)`,
          [instanceId, `/fake/${item}`, `hash-${item}`, anilistId, state]
        );
      const rejectsDuplicate = async (insert: () => Promise<unknown>) => {
        await queryRunner.query('SAVEPOINT manga_library_unique_check');
        await assert.rejects(insert(), /unique/i);
        await queryRunner.query(
          'ROLLBACK TO SAVEPOINT manga_library_unique_check'
        );
      };

      const migration = new AddMangaLibraryBindings1790986404000();
      await migration.up(queryRunner);
      await migration.up(queryRunner);

      assert.deepStrictEqual(await objects(), [
        'i IDX_manga_source_binding_anilistId',
        'i PK_manga_match_candidate',
        'i PK_manga_source_binding',
        'i UQ_manga_match_candidate_item',
        'i UQ_manga_source_binding_live',
        'i UQ_manga_source_binding_pair',
        'r manga_match_candidate',
        'r manga_source_binding',
      ]);
      const [{ definition }] = (await queryRunner.query(
        `SELECT pg_get_indexdef('"UQ_manga_source_binding_live"'::regclass) AS "definition"`
      )) as { definition: string }[];
      assert.match(
        definition,
        /^CREATE UNIQUE INDEX .*\("instanceId", "sourceId", "urlHash"\) WHERE .*'ACTIVE'.*'ORPHANED'/
      );

      await insertBinding('a', 10, 'ACTIVE');
      assert.deepStrictEqual(
        await queryRunner.query(
          `SELECT "inLibrary", "availability", "chapterCount", "createdAt" IS NOT NULL AS "stamped"
           FROM "manga_source_binding"`
        ),
        [
          {
            inLibrary: false,
            availability: 1,
            chapterCount: null,
            stamped: true,
          },
        ]
      );
      // One live binding per source manga, whichever live state it is in.
      await rejectsDuplicate(() => insertBinding('a', 11, 'ORPHANED'));
      await rejectsDuplicate(() => insertBinding('a', 11, 'ACTIVE'));
      // Rejections are per pair and coexist with the live binding.
      await insertBinding('a', 12, 'REJECTED');
      await insertBinding('a', 13, 'REJECTED');
      await rejectsDuplicate(() => insertBinding('a', 12, 'REJECTED'));
      await rejectsDuplicate(() => insertBinding('a', 10, 'REJECTED'));
      // The keys are per instance and per item.
      await insertBinding('a', 10, 'ACTIVE', 2);
      await insertBinding('b', 10, 'ACTIVE');
      // Once the live binding is rejected, another one may take its place.
      await queryRunner.query(
        `UPDATE "manga_source_binding" SET "state" = 'REJECTED'
         WHERE "instanceId" = 1 AND "urlHash" = 'hash-a' AND "anilistId" = 10`
      );
      await insertBinding('a', 14, 'ORPHANED');

      const insertCandidate = () =>
        queryRunner.query(
          `INSERT INTO "manga_match_candidate" ("instanceId", "sourceId", "url", "urlHash", "suwayomiMangaId", "title")
           VALUES (1, '0', '/fake/c', 'hash-c', 7, 'Fake Title')`
        );
      await insertCandidate();
      await rejectsDuplicate(insertCandidate);

      await migration.down(queryRunner);
      await migration.down(queryRunner);

      assert.deepStrictEqual(await objects(), []);
    });
  }
);

import assert from 'node:assert/strict';
import test from 'node:test';

import { AddMangaIdentityUniqueness1790986402000 as PortableMangaIdentityMigration } from '@server/migration/sqlite/1790986402000-AddMangaIdentityUniqueness';
import { AddMangaLibraryBindings1790986404000 as PortableMangaLibraryMigration } from '@server/migration/sqlite/1790986404000-AddMangaLibraryBindings';
import { AddMangaRequestManifests1790986406000 as PortableMangaRequestMigration } from '@server/migration/sqlite/1790986406000-AddMangaRequestManifests';
import { AddMangaSourceResolution1790986408000 as PortableMangaSourceResolutionMigration } from '@server/migration/sqlite/1790986408000-AddMangaSourceResolution';
import { DataSource, type QueryRunner } from 'typeorm';
import { AddMangaIdentityUniqueness1790986402000 } from './1790986402000-AddMangaIdentityUniqueness';
import { AddMangaQuota1790986403000 } from './1790986403000-AddMangaQuota';
import { AddMangaLibraryBindings1790986404000 } from './1790986404000-AddMangaLibraryBindings';
import { AddMangaMatchProposals1790986405000 } from './1790986405000-AddMangaMatchProposals';
import { AddMangaRequestManifests1790986406000 } from './1790986406000-AddMangaRequestManifests';
import { AddMangaSourceResolution1790986408000 } from './1790986408000-AddMangaSourceResolution';

const postgresUrl = process.env.SEERR_TEST_POSTGRES_URL;
const postgresTest = postgresUrl ? test : test.skip;

const MATCH_PROPOSAL_COLUMNS = [
  { name: 'malId', type: 'integer' },
  { name: 'malCheckedAt', type: 'timestamp with time zone' },
  { name: 'mangadexCheckedAt', type: 'timestamp with time zone' },
  { name: 'titleCheckedAt', type: 'timestamp with time zone' },
  { name: 'proposedAnilistId', type: 'integer' },
  { name: 'proposalConfidence', type: 'character varying(16)' },
  { name: 'proposalScore', type: 'integer' },
];

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

test('PostgreSQL manga match proposal migration adds and drops its columns', async () => {
  const migration = new AddMangaMatchProposals1790986405000();

  assert.equal(migration.name, 'AddMangaMatchProposals1790986405000');
  assert.deepStrictEqual(
    await recordStatements(async (queryRunner) => {
      await migration.up(queryRunner);
      await migration.down(queryRunner);
    }),
    [
      `ALTER TABLE "manga_match_candidate" ADD "malId" integer`,
      `ALTER TABLE "manga_match_candidate" ADD "malCheckedAt" TIMESTAMP WITH TIME ZONE`,
      `ALTER TABLE "manga_match_candidate" ADD "mangadexCheckedAt" TIMESTAMP WITH TIME ZONE`,
      `ALTER TABLE "manga_match_candidate" ADD "titleCheckedAt" TIMESTAMP WITH TIME ZONE`,
      `ALTER TABLE "manga_match_candidate" ADD "proposedAnilistId" integer`,
      `ALTER TABLE "manga_match_candidate" ADD "proposalConfidence" character varying(16)`,
      `ALTER TABLE "manga_match_candidate" ADD "proposalScore" integer`,
      `ALTER TABLE "manga_match_candidate" DROP COLUMN "proposalScore"`,
      `ALTER TABLE "manga_match_candidate" DROP COLUMN "proposalConfidence"`,
      `ALTER TABLE "manga_match_candidate" DROP COLUMN "proposedAnilistId"`,
      `ALTER TABLE "manga_match_candidate" DROP COLUMN "titleCheckedAt"`,
      `ALTER TABLE "manga_match_candidate" DROP COLUMN "mangadexCheckedAt"`,
      `ALTER TABLE "manga_match_candidate" DROP COLUMN "malCheckedAt"`,
      `ALTER TABLE "manga_match_candidate" DROP COLUMN "malId"`,
    ]
  );
});

test('PostgreSQL manga request manifest migration creates the SQLite indexes and drops both tables', async () => {
  const migration = new AddMangaRequestManifests1790986406000();
  const indexes = (statements: string[]) =>
    statements.filter((statement) => / INDEX /.test(statement));
  const postgres = await recordStatements((queryRunner) =>
    migration.up(queryRunner)
  );

  assert.equal(migration.name, 'AddMangaRequestManifests1790986406000');
  assert.equal(indexes(postgres).length, 2);
  assert.deepStrictEqual(
    indexes(postgres),
    indexes(
      await recordStatements((queryRunner) =>
        new PortableMangaRequestMigration().up(queryRunner)
      )
    )
  );
  assert.deepStrictEqual(
    await recordStatements((queryRunner) => migration.down(queryRunner)),
    [
      `DROP TABLE IF EXISTS "manga_request_chapter"`,
      `DROP TABLE IF EXISTS "manga_request_manifest"`,
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
  'PostgreSQL manga match proposal migration adds nullable columns reversibly',
  async () => {
    await withPostgresQueryRunner(async (queryRunner) => {
      await queryRunner.query(
        `CREATE TEMPORARY TABLE "manga_match_candidate" (
          "id" integer PRIMARY KEY,
          "title" varchar(512) NOT NULL
        )`
      );
      await queryRunner.query(
        `INSERT INTO "manga_match_candidate" ("id", "title") VALUES (1, 'Fake Library Title 1')`
      );
      const addedColumns = async () =>
        queryRunner.query(
          `SELECT a."attname" AS "name",
                  format_type(a."atttypid", a."atttypmod") AS "type",
                  a."attnotnull" AS "notNull"
           FROM pg_attribute a
           WHERE a."attrelid" = 'pg_temp."manga_match_candidate"'::regclass
             AND a."attnum" > 0
             AND NOT a."attisdropped"
             AND a."attname" NOT IN ('id', 'title')
           ORDER BY a."attnum"`
        );

      const migration = new AddMangaMatchProposals1790986405000();
      await migration.up(queryRunner);

      assert.deepStrictEqual(
        await addedColumns(),
        MATCH_PROPOSAL_COLUMNS.map((column) => ({ ...column, notNull: false }))
      );
      assert.deepStrictEqual(
        await queryRunner.query(
          `SELECT "malId", "titleCheckedAt", "proposalConfidence" FROM "manga_match_candidate"`
        ),
        [{ malId: null, titleCheckedAt: null, proposalConfidence: null }]
      );

      await migration.down(queryRunner);

      assert.deepStrictEqual(await addedColumns(), []);
      assert.deepStrictEqual(
        await queryRunner.query(
          `SELECT "id", "title" FROM "manga_match_candidate"`
        ),
        [{ id: 1, title: 'Fake Library Title 1' }]
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

postgresTest(
  'PostgreSQL manga request manifest migration keys manifests and chapters reversibly',
  async () => {
    await withPostgresQueryRunner(async (queryRunner) => {
      // A private schema keeps the migrated database's tables out of reach,
      // and the rollback removes it again.
      await queryRunner.query(`CREATE SCHEMA "manga_request_check"`);
      await queryRunner.query(`SET LOCAL search_path TO "manga_request_check"`);
      await queryRunner.query(
        `CREATE TABLE "media_request" ("id" integer PRIMARY KEY)`
      );
      const objects = async () =>
        (
          (await queryRunner.query(
            `SELECT c."relkind" AS "kind", c."relname" AS "name"
             FROM pg_class c
             JOIN pg_namespace n ON n."oid" = c."relnamespace"
             WHERE n."nspname" = 'manga_request_check'
               AND c."relkind" IN ('r', 'i')
               AND c."relname" LIKE '%manga_request%'
             ORDER BY c."relkind", c."relname"`
          )) as { kind: string; name: string }[]
        ).map(({ kind, name }) => `${kind} ${name}`);
      const insertManifest = (requestId: number) =>
        queryRunner.query(
          `INSERT INTO "manga_request_manifest" ("requestId", "anilistId", "instanceId") VALUES ($1, 900001, 1)`,
          [requestId]
        );
      const insertChapter = (manifestId: number, item: string) =>
        queryRunner.query(
          `INSERT INTO "manga_request_chapter" ("manifestId", "url", "urlHash", "chapterNumber") VALUES ($1, $2, $3, 1.5)`,
          [manifestId, `/fake/chapter/${item}`, `hash-${item}`]
        );
      const rejects = async (
        insert: () => Promise<unknown>,
        pattern: RegExp
      ) => {
        await queryRunner.query('SAVEPOINT manga_request_check');
        await assert.rejects(insert(), pattern);
        await queryRunner.query('ROLLBACK TO SAVEPOINT manga_request_check');
      };

      const migration = new AddMangaRequestManifests1790986406000();
      await migration.up(queryRunner);
      await migration.up(queryRunner);

      assert.deepStrictEqual(await objects(), [
        'i IDX_manga_request_manifest_anilistId',
        'i IDX_manga_request_manifest_instanceId',
        'i PK_manga_request_chapter',
        'i PK_manga_request_manifest',
        'i UQ_manga_request_chapter_manifest_url',
        'i UQ_manga_request_manifest_request',
        'r manga_request_chapter',
        'r manga_request_manifest',
      ]);

      await queryRunner.query(
        `INSERT INTO "media_request" ("id") VALUES (1), (2)`
      );
      await insertManifest(1);
      assert.deepStrictEqual(
        await queryRunner.query(
          `SELECT "scope", "latestCount", "bindingState", "boundAt", "checkpoint", "attempts", "frozenAt", "createdAt" IS NOT NULL AS "stamped"
           FROM "manga_request_manifest"`
        ),
        [
          {
            scope: 'ALL_AT_DISPATCH',
            latestCount: null,
            bindingState: 'AWAITING_BINDING',
            boundAt: null,
            checkpoint: null,
            attempts: 0,
            frozenAt: null,
            stamped: true,
          },
        ]
      );
      await rejects(() => insertManifest(1), /unique/i);
      await insertManifest(2);
      const manifestIds = (
        (await queryRunner.query(
          `SELECT "id" FROM "manga_request_manifest" ORDER BY "requestId"`
        )) as { id: number }[]
      ).map(({ id }) => id);
      await insertChapter(manifestIds[0], 'a');
      await rejects(() => insertChapter(manifestIds[0], 'a'), /unique/i);
      await insertChapter(manifestIds[1], 'a');

      await queryRunner.query(`DELETE FROM "media_request" WHERE "id" = 1`);
      assert.deepStrictEqual(
        await queryRunner.query(
          `SELECT "manifestId" FROM "manga_request_chapter"`
        ),
        [{ manifestId: manifestIds[1] }]
      );
      await rejects(() => insertManifest(3), /foreign key/i);

      await migration.down(queryRunner);
      await migration.down(queryRunner);

      assert.deepStrictEqual(await objects(), []);
    });
  }
);

test('PostgreSQL manga source resolution migration creates the SQLite indexes and drops both tables', async () => {
  const migration = new AddMangaSourceResolution1790986408000();
  const indexes = (statements: string[]) =>
    statements.filter((statement) => / INDEX /.test(statement));
  const postgres = await recordStatements((queryRunner) =>
    migration.up(queryRunner)
  );

  assert.equal(migration.name, 'AddMangaSourceResolution1790986408000');
  assert.equal(indexes(postgres).length, 2);
  assert.deepStrictEqual(
    indexes(postgres),
    indexes(
      await recordStatements((queryRunner) =>
        new PortableMangaSourceResolutionMigration().up(queryRunner)
      )
    )
  );
  assert.deepStrictEqual(
    await recordStatements((queryRunner) => migration.down(queryRunner)),
    [
      `DROP TABLE IF EXISTS "manga_source_candidate"`,
      `DROP TABLE IF EXISTS "manga_source_resolution"`,
    ]
  );
});

postgresTest(
  'PostgreSQL manga source resolution migration keys titles and candidates reversibly',
  async () => {
    await withPostgresQueryRunner(async (queryRunner) => {
      // A private schema keeps the migrated database's tables out of reach,
      // and the rollback removes it again.
      await queryRunner.query(`CREATE SCHEMA "manga_source_check"`);
      await queryRunner.query(`SET LOCAL search_path TO "manga_source_check"`);
      const objects = async () =>
        (
          (await queryRunner.query(
            `SELECT c."relkind" AS "kind", c."relname" AS "name"
             FROM pg_class c
             JOIN pg_namespace n ON n."oid" = c."relnamespace"
             WHERE n."nspname" = 'manga_source_check'
               AND c."relkind" IN ('r', 'i')
             ORDER BY c."relkind", c."relname"`
          )) as { kind: string; name: string }[]
        ).map(({ kind, name }) => `${kind} ${name}`);
      const rejectsDuplicate = async (insert: () => Promise<unknown>) => {
        await queryRunner.query('SAVEPOINT manga_source_check');
        await assert.rejects(insert(), /unique/i);
        await queryRunner.query('ROLLBACK TO SAVEPOINT manga_source_check');
      };
      const insertResolution = (anilistId: number) =>
        queryRunner.query(
          `INSERT INTO "manga_source_resolution" ("instanceId", "anilistId") VALUES (1, $1)`,
          [anilistId]
        );
      const insertCandidate = (anilistId: number, item: string) =>
        queryRunner.query(
          `INSERT INTO "manga_source_candidate" ("instanceId", "anilistId", "sourceId", "url", "urlHash", "suwayomiMangaId", "title", "score", "confidence", "matchedBy")
           VALUES (1, $1, '1001', $2, $3, 7, 'Synthetic Title', 800, 'MEDIUM', 'title')`,
          [anilistId, `/fake/${item}`, `hash-${item}`]
        );

      const migration = new AddMangaSourceResolution1790986408000();
      await migration.up(queryRunner);
      await migration.up(queryRunner);

      assert.deepStrictEqual(await objects(), [
        'i PK_manga_source_candidate',
        'i PK_manga_source_resolution',
        'i UQ_manga_source_candidate_item',
        'i UQ_manga_source_resolution_title',
        'r manga_source_candidate',
        'r manga_source_resolution',
      ]);

      await insertResolution(900001);
      assert.deepStrictEqual(
        await queryRunner.query(
          `SELECT "status", "reason", "attempts", "nextAttemptAt", "lastError", "createdAt" IS NOT NULL AS "stamped"
           FROM "manga_source_resolution"`
        ),
        [
          {
            status: 'QUEUED',
            reason: null,
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
            stamped: true,
          },
        ]
      );
      await rejectsDuplicate(() => insertResolution(900001));
      await insertResolution(900002);

      await insertCandidate(900001, 'a');
      assert.deepStrictEqual(
        await queryRunner.query(
          `SELECT "sourceName", "sourceLang", "inLibrary" FROM "manga_source_candidate"`
        ),
        [{ sourceName: '', sourceLang: '', inLibrary: false }]
      );
      await rejectsDuplicate(() => insertCandidate(900001, 'a'));
      await insertCandidate(900001, 'b');
      await insertCandidate(900002, 'a');

      await migration.down(queryRunner);
      await migration.down(queryRunner);

      assert.deepStrictEqual(await objects(), []);
    });
  }
);

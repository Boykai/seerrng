// Verifies the migrations against the entities (SQLite by default, PostgreSQL
// with DB_TYPE=postgres). Run it through scripts/manga-migration-checks.mjs,
// which builds the configured database from empty with WITH_MIGRATIONS=true
// and names a second, empty database in DRIFT_ENTITY_DATABASE (a file for
// SQLite, a database on the same server for PostgreSQL):
//
// 1. Round trip: undo every migration back to the oldest manga migration,
//    check that the manga schema objects are gone, run the migrations again
//    and check that the same migrations and objects are back.
// 2. Drift: synchronize() builds the entity schema in the second database.
//    Both databases are read through the same introspection and compared as
//    schema records (migrationDrift.ts). The drift must match the reviewed
//    allowlist in migration-drift-allowlist/<driver>.json exactly.
//
// `--write-allowlist` skips the round trip and rewrites the allowlist from the
// current drift, keeping existing reasons. It refuses manga drift, and every
// new entry needs a written reason before the check passes.
import dataSource from '@server/datasource';
import type {
  DriftAllowlist,
  SchemaRecord,
} from '@server/scripts/migrationDrift';
import {
  buildDriftAllowlist,
  checkDriftAllowlist,
  describeDriftCheck,
  diffSchemaRecords,
  formatDriftAllowlist,
  parseDriftAllowlist,
  recordsFromTables,
  selectRoundTripMigrations,
} from '@server/scripts/migrationDrift';
import { isPgsql } from '@server/utils/dbType';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { DataSourceOptions, QueryRunner } from 'typeorm';
import { DataSource, MigrationExecutor } from 'typeorm';

type SchemaObject =
  | { kind: 'column'; table: string; name: string }
  | { kind: 'index'; table: string; name: string };

const ROUND_TRIP_MIGRATION_PATTERN = /Manga/;

// Every schema object the manga migrations create. Later layers append theirs.
const MANGA_SCHEMA_OBJECTS: readonly SchemaObject[] = [
  {
    kind: 'index',
    table: 'media_identifier',
    name: 'UQ_media_identifier_canonical_manga',
  },
  { kind: 'column', table: 'user', name: 'mangaQuotaLimit' },
  { kind: 'column', table: 'user', name: 'mangaQuotaDays' },
  { kind: 'column', table: 'manga_source_binding', name: 'urlHash' },
  { kind: 'column', table: 'manga_source_binding', name: 'availability' },
  {
    kind: 'index',
    table: 'manga_source_binding',
    name: 'IDX_manga_source_binding_anilistId',
  },
  {
    kind: 'index',
    table: 'manga_source_binding',
    name: 'UQ_manga_source_binding_pair',
  },
  {
    kind: 'index',
    table: 'manga_source_binding',
    name: 'UQ_manga_source_binding_live',
  },
  { kind: 'column', table: 'manga_match_candidate', name: 'urlHash' },
  {
    kind: 'index',
    table: 'manga_match_candidate',
    name: 'UQ_manga_match_candidate_item',
  },
  ...[
    'malId',
    'malCheckedAt',
    'mangadexCheckedAt',
    'titleCheckedAt',
    'proposedAnilistId',
    'proposalConfidence',
    'proposalScore',
  ].map((name): SchemaObject => ({
    kind: 'column',
    table: 'manga_match_candidate',
    name,
  })),
  // Manga request manifests and their chapter rows.
  ...[
    'requestId',
    'anilistId',
    'instanceId',
    'scope',
    'latestCount',
    'rangeStart',
    'rangeEnd',
    'bindingState',
    'boundAt',
    'checkpoint',
    'checkpointAt',
    'attempts',
    'lastError',
    'frozenAt',
  ].map((name): SchemaObject => ({
    kind: 'column',
    table: 'manga_request_manifest',
    name,
  })),
  {
    kind: 'index',
    table: 'manga_request_manifest',
    name: 'IDX_manga_request_manifest_anilistId',
  },
  {
    kind: 'index',
    table: 'manga_request_manifest',
    name: 'IDX_manga_request_manifest_instanceId',
  },
  ...['manifestId', 'url', 'urlHash', 'chapterNumber', 'scanlator'].map(
    (name): SchemaObject => ({
      kind: 'column',
      table: 'manga_request_chapter',
      name,
    })
  ),
  // The source resolver's per-title state and its candidates.
  ...[
    'instanceId',
    'anilistId',
    'status',
    'reason',
    'mangadexUuid',
    'searchRequestedAt',
    'checkedAt',
    'searchedAt',
    'attempts',
    'nextAttemptAt',
    'lastError',
  ].map((name): SchemaObject => ({
    kind: 'column',
    table: 'manga_source_resolution',
    name,
  })),
  {
    kind: 'index',
    table: 'manga_source_resolution',
    name: 'UQ_manga_source_resolution_title',
  },
  ...[
    'instanceId',
    'anilistId',
    'sourceId',
    'sourceName',
    'sourceLang',
    'url',
    'urlHash',
    'suwayomiMangaId',
    'title',
    'inLibrary',
    'score',
    'confidence',
    'matchedBy',
  ].map((name): SchemaObject => ({
    kind: 'column',
    table: 'manga_source_candidate',
    name,
  })),
  {
    kind: 'index',
    table: 'manga_source_candidate',
    name: 'UQ_manga_source_candidate_item',
  },
];

const driver = isPgsql ? 'postgres' : 'sqlite';
const allowlistPath = path.join(
  __dirname,
  'migration-drift-allowlist',
  `${driver}.json`
);

const log = (message: string) => process.stdout.write(`${message}\n`);

const executedMigrationNames = async () =>
  (await new MigrationExecutor(dataSource).getExecutedMigrations()).map(
    (migration) => migration.name
  );

const objectExists = async (
  queryRunner: QueryRunner,
  object: SchemaObject
): Promise<boolean> => {
  if (object.kind === 'column') {
    return queryRunner.hasColumn(object.table, object.name);
  }

  const rows: unknown[] = isPgsql
    ? await queryRunner.query(
        'SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexname = $2',
        [object.table, object.name]
      )
    : await queryRunner.query(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?",
        [object.table, object.name]
      );

  return rows.length > 0;
};

const assertSchemaObjects = async (shouldExist: boolean, stage: string) => {
  const queryRunner = dataSource.createQueryRunner();

  try {
    for (const object of MANGA_SCHEMA_OBJECTS) {
      if ((await objectExists(queryRunner, object)) !== shouldExist) {
        throw new Error(
          `${stage}: ${object.kind} "${object.table}"."${object.name}" should ${
            shouldExist ? 'exist' : 'be absent'
          }.`
        );
      }
    }
  } finally {
    await queryRunner.release();
  }
};

const assertSameNames = (
  actual: readonly string[],
  expected: readonly string[],
  stage: string
) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${stage}: expected [${expected.join(', ')}] but found [${actual.join(', ')}].`
    );
  }
};

const runRoundTrip = async () => {
  const executed = await executedMigrationNames();
  const roundTrip = selectRoundTripMigrations(
    executed,
    ROUND_TRIP_MIGRATION_PATTERN
  );

  if (roundTrip.length === 0) {
    throw new Error(
      `No executed migration matches ${ROUND_TRIP_MIGRATION_PATTERN}; the round trip has nothing to verify.`
    );
  }

  await assertSchemaObjects(true, 'After migrating from empty');

  for (const name of roundTrip) {
    log(`${driver}: reverting ${name}`);
    await dataSource.undoLastMigration({ transaction: 'each' });
  }

  assertSameNames(
    await executedMigrationNames(),
    executed.slice(roundTrip.length),
    'After reverting'
  );
  await assertSchemaObjects(false, 'After reverting the manga migrations');

  const reapplied = await dataSource.runMigrations({ transaction: 'each' });
  assertSameNames(
    reapplied.map((migration) => migration.name),
    [...roundTrip].reverse(),
    'Re-applied migrations'
  );
  assertSameNames(await executedMigrationNames(), executed, 'After re-running');
  await assertSchemaObjects(true, 'After re-running the manga migrations');

  log(`${driver}: round trip passed for ${roundTrip.length} migration(s)`);
};

// TypeORM bookkeeping rather than schema: only the migrated database has it.
const BOOKKEEPING_TABLES = new Set(['migrations', 'typeorm_metadata']);

const TABLES_SQL = isPgsql
  ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'"
  : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";

// getTables() does not report PostgreSQL index key order; read it here.
const INDEX_KEYS_SQL = `SELECT i.relname AS name, json_agg(a.attname ORDER BY k.ord) AS key_columns
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_namespace n ON n.oid = i.relnamespace
  CROSS JOIN LATERAL unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
  WHERE n.nspname = current_schema()
  GROUP BY i.relname`;

const ENUMS_SQL = `SELECT t.typname AS name, json_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = current_schema()
  GROUP BY t.typname`;

const tableNames = async (source: { query(sql: string): Promise<unknown> }) =>
  ((await source.query(TABLES_SQL)) as { name: string }[]).map(
    (row) => row.name
  );

// Both databases are read through this one code path.
const introspect = async (source: DataSource): Promise<SchemaRecord[]> => {
  const queryRunner = source.createQueryRunner();

  try {
    const tables = await queryRunner.getTables(
      (await tableNames(queryRunner)).filter(
        (name) => !BOOKKEEPING_TABLES.has(name)
      )
    );

    if (!isPgsql) {
      return recordsFromTables(tables);
    }

    const keys = (await queryRunner.query(INDEX_KEYS_SQL)) as {
      name: string;
      key_columns: string[];
    }[];
    const enums = (await queryRunner.query(ENUMS_SQL)) as {
      name: string;
      labels: string[];
    }[];

    return [
      ...recordsFromTables(tables, {
        checks: true,
        foreignKeyNames: true,
        keyOrder: new Map(keys.map((row) => [row.name, row.key_columns])),
      }),
      ...enums.map((row): SchemaRecord => ({
        kind: 'enum',
        name: row.name,
        values: row.labels,
      })),
    ];
  } finally {
    await queryRunner.release();
  }
};

const entityDataSource = () => {
  const database = process.env.DRIFT_ENTITY_DATABASE;
  if (!database) {
    throw new Error(
      'DRIFT_ENTITY_DATABASE must name an empty database for the entity schema; scripts/manga-migration-checks.mjs sets it.'
    );
  }

  return new DataSource({
    ...dataSource.options,
    database,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: false,
    migrations: [],
    subscribers: [],
  } as DataSourceOptions);
};

const readAllowlist = (requireReasons: boolean) =>
  parseDriftAllowlist(readFileSync(allowlistPath, 'utf8'), allowlistPath, {
    requireReasons,
  });

const readPreviousAllowlist = (): DriftAllowlist | undefined => {
  try {
    return readAllowlist(false);
  } catch {
    return undefined;
  }
};

const main = async () => {
  const writeAllowlist = process.argv.includes('--write-allowlist');
  const entities = entityDataSource();

  dataSource.setOptions({
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: false,
  });
  await dataSource.initialize();

  try {
    if (await dataSource.showMigrations()) {
      throw new Error(
        'Pending migrations found; build the database from empty with WITH_MIGRATIONS=true first.'
      );
    }

    if (!writeAllowlist) {
      await runRoundTrip();
    }

    await entities.initialize();
    if ((await tableNames(entities)).length > 0) {
      throw new Error(
        'The entity database must start empty; synchronize() builds it.'
      );
    }
    await entities.synchronize();

    const drift = diffSchemaRecords(
      await introspect(dataSource),
      await introspect(entities)
    );

    if (writeAllowlist) {
      const allowlist = buildDriftAllowlist(
        drift,
        readPreviousAllowlist(),
        `Schema records that differ between a ${driver} database built from empty by the migrations and one built by synchronize() from the entities. Each predates the manga work and has a reviewed reason; manga drift is never allowlisted. Any other drift, or an entry that no longer drifts, fails scripts/manga-migration-checks.mjs.`
      );
      writeFileSync(allowlistPath, formatDriftAllowlist(allowlist));
      const unexplained = allowlist.records.filter(
        (entry) => entry.reason.trim() === ''
      ).length;
      log(
        `${driver}: wrote ${allowlist.records.length} drift record(s) to ${allowlistPath}${
          unexplained > 0 ? `; ${unexplained} still need a reason` : ''
        }`
      );
      return 0;
    }

    const check = checkDriftAllowlist(drift, readAllowlist(true));

    if (
      check.unexpected.length > 0 ||
      check.stale.length > 0 ||
      check.forbidden.length > 0
    ) {
      process.stderr.write(`${describeDriftCheck(driver, check)}\n`);
      return 1;
    }

    log(
      `${driver}: ${drift.length} drift record(s), all in the reviewed allowlist`
    );
    return 0;
  } finally {
    if (entities.isInitialized) {
      await entities.destroy();
    }
    await dataSource.destroy();
  }
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
  }
);

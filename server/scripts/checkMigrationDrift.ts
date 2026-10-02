// Verifies the migrations against the entities on the configured database
// (SQLite by default, PostgreSQL with DB_TYPE=postgres). Run it after the
// database has been built from empty with WITH_MIGRATIONS=true, through
// scripts/manga-migration-checks.mjs:
//
// 1. Round trip: undo every migration back to the oldest manga migration,
//    check that the manga schema objects are gone, run the migrations again
//    and check that the same migrations and objects are back.
// 2. Drift: the statements TypeORM's schema builder would still run (what
//    `migration:generate --check` reports) must match the reviewed allowlist
//    in migration-drift-allowlist/<driver>.json exactly.
//
// `--write-allowlist` skips the round trip and rewrites the allowlist from the
// current drift. Only do that for reviewed, pre-existing drift.
import dataSource from '@server/datasource';
import type { DriftAllowlist } from '@server/scripts/migrationDrift';
import {
  compareDriftStatements,
  describeDriftComparison,
  formatDriftAllowlist,
  normalizeDriftQuery,
  parseDriftAllowlist,
  selectRoundTripMigrations,
} from '@server/scripts/migrationDrift';
import { isPgsql } from '@server/utils/dbType';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { QueryRunner } from 'typeorm';
import { MigrationExecutor } from 'typeorm';

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

const captureDrift = async () =>
  (await dataSource.driver.createSchemaBuilder().log()).upQueries.map(
    normalizeDriftQuery
  );

const main = async () => {
  const writeAllowlist = process.argv.includes('--write-allowlist');

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

    if (writeAllowlist) {
      const allowlist: DriftAllowlist = {
        description: `Reviewed schema drift that TypeORM still reports on ${driver} after every migration has run. It predates the manga work and is deliberately not fixed here. Any other drift fails scripts/manga-migration-checks.mjs.`,
        statements: await captureDrift(),
      };
      writeFileSync(allowlistPath, formatDriftAllowlist(allowlist));
      log(
        `${driver}: wrote ${allowlist.statements.length} statement(s) to ${allowlistPath}`
      );
      return 0;
    }

    await runRoundTrip();

    const comparison = compareDriftStatements(
      await captureDrift(),
      parseDriftAllowlist(readFileSync(allowlistPath, 'utf8'), allowlistPath)
        .statements
    );

    if (comparison.unexpected.length > 0 || comparison.stale.length > 0) {
      process.stderr.write(`${describeDriftComparison(driver, comparison)}\n`);
      return 1;
    }

    log(`${driver}: no schema drift beyond the reviewed allowlist`);
    return 0;
  } finally {
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

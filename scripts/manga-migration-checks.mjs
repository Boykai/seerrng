#!/usr/bin/env node
// Builds the database from empty with migrations and creates a second, empty
// database for the entity schema, then runs the migration round trip and the
// entity/migration drift check (server/scripts/checkMigrationDrift.ts). Used
// locally and by .github/workflows/manga-checks.yml.
//
//   node scripts/manga-migration-checks.mjs sqlite [--write-allowlist]
//   node scripts/manga-migration-checks.mjs postgres [--write-allowlist]
//
// PostgreSQL runs in a disposable container from a digest-pinned public image.
// It is published on 127.0.0.1 only, uses a random password that never
// appears on a command line, and is always removed with its volume.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const POSTGRES_IMAGE =
  'postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
export const POSTGRES_USER = 'postgres';
export const POSTGRES_DATABASE = 'seerr';
// The entity schema is built by synchronize() in a second, empty database:
// a file next to the SQLite database, or a database in the same container.
export const POSTGRES_ENTITY_DATABASE = 'seerr_entities';
export const SQLITE_ENTITY_DATABASE = 'entities.sqlite3';
export const POSTGRES_MIGRATION_TESTS = [
  'server/migration/postgres/mangaMigrations.test.ts',
];

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const require = createRequire(import.meta.url);
const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const READY_ATTEMPTS = 60;

export class UsageError extends Error {}

export const parseArguments = (argv) => {
  const [driver, ...options] = argv;

  if (driver !== 'sqlite' && driver !== 'postgres') {
    throw new UsageError(
      'Usage: node scripts/manga-migration-checks.mjs sqlite|postgres [--write-allowlist]'
    );
  }

  const unknown = options.filter((option) => option !== '--write-allowlist');
  if (unknown.length > 0) {
    throw new UsageError(`Unknown option(s): ${unknown.join(' ')}`);
  }

  return { driver, writeAllowlist: options.includes('--write-allowlist') };
};

export const createDatabasePassword = () =>
  randomBytes(24).toString('base64url');

export const actionsMaskCommand = (secret, env) =>
  env.GITHUB_ACTIONS === 'true' ? `::add-mask::${secret}` : undefined;

export const postgresRunArguments = (containerName, image = POSTGRES_IMAGE) => [
  'run',
  '--detach',
  '--name',
  containerName,
  // Without a value, docker reads POSTGRES_PASSWORD from its own environment.
  '--env',
  'POSTGRES_PASSWORD',
  '--env',
  `POSTGRES_USER=${POSTGRES_USER}`,
  '--env',
  `POSTGRES_DB=${POSTGRES_DATABASE}`,
  '--publish',
  '127.0.0.1::5432',
  image,
];

export const postgresReadyArguments = (containerName) => [
  'exec',
  containerName,
  'pg_isready',
  '--host',
  '127.0.0.1',
  '--port',
  '5432',
  '--username',
  POSTGRES_USER,
  '--dbname',
  POSTGRES_DATABASE,
];

export const postgresCreateDatabaseArguments = (containerName) => [
  'exec',
  containerName,
  'createdb',
  '--username',
  POSTGRES_USER,
  POSTGRES_ENTITY_DATABASE,
];

export const postgresRemoveArguments = (containerName) => [
  'rm',
  '--force',
  '--volumes',
  containerName,
];

export const parsePublishedPort = (output) => {
  const mappings = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const ports = mappings.map(
    (mapping) => /^127\.0\.0\.1:(\d{1,5})$/u.exec(mapping)?.[1]
  );

  if (ports.length === 0 || ports.some((port) => port === undefined)) {
    throw new Error(
      `PostgreSQL must be published on 127.0.0.1 only; docker reported: ${
        mappings.join(', ') || '(no mapping)'
      }`
    );
  }

  return Number(ports[0]);
};

export const databaseEnvironment = ({ baseEnv, configDirectory, postgres }) => {
  const env = { ...baseEnv };

  // NODE_ENV=test selects the in-memory database and NODE_ENV=production the
  // compiled dist/ entities; both would skip the database under test.
  delete env.NODE_ENV;
  delete env.PRESERVE_DB;
  delete env.DRIFT_ENTITY_DATABASE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('DB_')) {
      delete env[key];
    }
  }

  env.CONFIG_DIRECTORY = configDirectory;
  env.WITH_MIGRATIONS = 'true';

  if (postgres) {
    Object.assign(env, {
      DB_TYPE: 'postgres',
      DB_HOST: '127.0.0.1',
      DB_PORT: String(postgres.port),
      DB_USER: POSTGRES_USER,
      DB_PASS: postgres.password,
      DB_NAME: POSTGRES_DATABASE,
    });
  }

  return env;
};

export const postgresTestUrl = ({ port, password }) =>
  `postgres://${POSTGRES_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${POSTGRES_DATABASE}`;

const tsNodeArguments = (script, scriptArguments = []) => [
  require.resolve('ts-node/dist/bin.js'),
  '-r',
  'tsconfig-paths/register',
  '--files',
  '--project',
  'server/tsconfig.json',
  script,
  ...scriptArguments,
];

const defaultRun = (command, args, { env, capture = false } = {}) => {
  const result = spawnSync(command, args, {
    cwd: rootDirectory,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: STEP_TIMEOUT_MS,
    windowsHide: true,
  });

  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? result.error.message : (result.stderr ?? ''),
  };
};

const defaultDependencies = () => ({
  run: defaultRun,
  log: (message) => process.stdout.write(`${message}\n`),
  env: process.env,
  createPassword: createDatabasePassword,
  createContainerName: () =>
    `seerrng-manga-migrations-${randomBytes(6).toString('hex')}`,
  makeConfigDirectory: () =>
    mkdtempSync(path.join(tmpdir(), 'seerrng-manga-migrations-')),
  removeConfigDirectory: (directory) =>
    rmSync(directory, { recursive: true, force: true }),
  wait: () => delay(1000),
});

const runStep = (dependencies, label, command, args, options) => {
  const inActions = dependencies.env.GITHUB_ACTIONS === 'true';
  dependencies.log(inActions ? `::group::${label}` : `==> ${label}`);
  const result = dependencies.run(command, args, options);
  if (inActions) {
    dependencies.log('::endgroup::');
  }

  if (result.status !== 0) {
    const detail = options?.capture ? result.stderr.trim() : '';
    throw new Error(
      `${label} failed (exit ${result.status})${detail ? `: ${detail}` : '.'}`
    );
  }

  return result;
};

const runDatabaseChecks = (
  dependencies,
  { driver, writeAllowlist },
  env,
  entityDatabase
) => {
  runStep(
    dependencies,
    `${driver}: build the database from empty with migrations`,
    process.execPath,
    tsNodeArguments('server/scripts/prepareTestDb.ts'),
    { env }
  );
  runStep(
    dependencies,
    writeAllowlist
      ? `${driver}: write the drift allowlist`
      : `${driver}: migration round trip and drift check`,
    process.execPath,
    tsNodeArguments(
      'server/scripts/checkMigrationDrift.ts',
      writeAllowlist ? ['--write-allowlist'] : []
    ),
    { env: { ...env, DRIFT_ENTITY_DATABASE: entityDatabase } }
  );

  if (writeAllowlist) {
    runStep(
      dependencies,
      `${driver}: format the drift allowlist`,
      process.execPath,
      [
        path.join(
          rootDirectory,
          'node_modules',
          'prettier',
          'bin',
          'prettier.cjs'
        ),
        '--write',
        `server/scripts/migration-drift-allowlist/${driver}.json`,
      ],
      { env }
    );
  }
};

const waitForPostgres = async (dependencies, containerName) => {
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1) {
    const result = dependencies.run(
      'docker',
      postgresReadyArguments(containerName),
      { env: dependencies.env, capture: true }
    );
    if (result.status === 0) {
      return;
    }
    await dependencies.wait();
  }

  throw new Error(
    `PostgreSQL did not become ready after ${READY_ATTEMPTS} attempts.`
  );
};

const runPostgresChecks = async (dependencies, options, configDirectory) => {
  const password = dependencies.createPassword();
  const containerName = dependencies.createContainerName();
  const mask = actionsMaskCommand(password, dependencies.env);
  if (mask) {
    dependencies.log(mask);
  }

  try {
    runStep(
      dependencies,
      `postgres: start ${POSTGRES_IMAGE} on 127.0.0.1`,
      'docker',
      postgresRunArguments(containerName),
      {
        env: { ...dependencies.env, POSTGRES_PASSWORD: password },
        capture: true,
      }
    );
    await waitForPostgres(dependencies, containerName);
    const port = parsePublishedPort(
      runStep(
        dependencies,
        'postgres: read the loopback port',
        'docker',
        ['port', containerName, '5432/tcp'],
        { env: dependencies.env, capture: true }
      ).stdout
    );
    const postgres = { port, password };
    runStep(
      dependencies,
      'postgres: create the empty entity database',
      'docker',
      postgresCreateDatabaseArguments(containerName),
      { env: dependencies.env, capture: true }
    );

    runDatabaseChecks(
      dependencies,
      options,
      databaseEnvironment({
        baseEnv: dependencies.env,
        configDirectory,
        postgres,
      }),
      POSTGRES_ENTITY_DATABASE
    );

    if (!options.writeAllowlist) {
      runStep(
        dependencies,
        'postgres: manga migration tests',
        process.execPath,
        ['server/test/index.mts', ...POSTGRES_MIGRATION_TESTS],
        {
          env: {
            ...databaseEnvironment({
              baseEnv: dependencies.env,
              configDirectory,
            }),
            SEERR_TEST_POSTGRES_URL: postgresTestUrl(postgres),
          },
        }
      );
    }
  } finally {
    const removal = dependencies.run(
      'docker',
      postgresRemoveArguments(containerName),
      { env: dependencies.env, capture: true }
    );
    if (removal.status !== 0) {
      dependencies.log(
        `Could not remove container ${containerName}: ${removal.stderr.trim()}`
      );
    }
  }
};

export const runMigrationChecks = async (
  options,
  dependencies = defaultDependencies()
) => {
  const configDirectory = dependencies.makeConfigDirectory();

  try {
    if (options.driver === 'postgres') {
      await runPostgresChecks(dependencies, options, configDirectory);
    } else {
      runDatabaseChecks(
        dependencies,
        options,
        databaseEnvironment({ baseEnv: dependencies.env, configDirectory }),
        path.join(configDirectory, SQLITE_ENTITY_DATABASE)
      );
    }
  } finally {
    dependencies.removeConfigDirectory(configDirectory);
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await runMigrationChecks(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

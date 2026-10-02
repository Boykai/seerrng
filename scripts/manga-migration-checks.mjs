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
// It is published on 127.0.0.1 only and uses a random password that never
// appears on a command line. The container, its volume and the temporary
// config directory are removed when the run ends, fails or is interrupted by
// SIGHUP, SIGINT or SIGTERM. Steps run synchronously, so a signal sent to
// this process alone takes effect when the current step ends; Ctrl+C also
// stops the step itself.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants, tmpdir } from 'node:os';
import path from 'node:path';
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from 'node:timers/promises';
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

export const INTERRUPT_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'];

// The status a shell reports for a process that a signal ended.
export const signalExitCode = (signal) => 128 + constants.signals[signal];

// Cleanup tasks run newest first and at most once each. When an interrupt and
// the end of the run both ask for them, the second caller waits for the
// cleanup already in progress. A failing task is logged and the rest still
// run, so a cleanup error never hides the result of the checks.
export const createCleanups = (log) => {
  const tasks = [];
  let running;

  const drain = async () => {
    while (tasks.length > 0) {
      const task = tasks.pop();
      try {
        await task();
      } catch (error) {
        log(
          `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };

  return {
    add: (task) => {
      tasks.push(task);
    },
    run: () => {
      running ??= drain().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
};

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
  onInterrupt: (listener) => {
    for (const signal of INTERRUPT_SIGNALS) {
      process.on(signal, listener);
    }
    return () => {
      for (const signal of INTERRUPT_SIGNALS) {
        process.off(signal, listener);
      }
    };
  },
  exit: (code) => process.exit(code),
});

const runStep = async (context, label, command, args, options) => {
  // Lets Node deliver a pending signal before the next blocking step.
  await nextTurn();
  context.interruption.throwIfAborted();

  const inActions = context.env.GITHUB_ACTIONS === 'true';
  context.log(inActions ? `::group::${label}` : `==> ${label}`);
  const result = context.run(command, args, options);
  if (inActions) {
    context.log('::endgroup::');
  }

  if (result.status !== 0) {
    const detail = options?.capture ? result.stderr.trim() : '';
    throw new Error(
      `${label} failed (exit ${result.status})${detail ? `: ${detail}` : '.'}`
    );
  }

  return result;
};

const runDatabaseChecks = async (
  context,
  { driver, writeAllowlist },
  env,
  entityDatabase
) => {
  await runStep(
    context,
    `${driver}: build the database from empty with migrations`,
    process.execPath,
    tsNodeArguments('server/scripts/prepareTestDb.ts'),
    { env }
  );
  await runStep(
    context,
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
    await runStep(
      context,
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

const waitForPostgres = async (context, containerName) => {
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1) {
    context.interruption.throwIfAborted();
    const result = context.run(
      'docker',
      postgresReadyArguments(containerName),
      { env: context.env, capture: true }
    );
    if (result.status === 0) {
      return;
    }
    await context.wait();
  }

  throw new Error(
    `PostgreSQL did not become ready after ${READY_ATTEMPTS} attempts.`
  );
};

const runPostgresChecks = async (context, options, configDirectory) => {
  const password = context.createPassword();
  const containerName = context.createContainerName();
  const mask = actionsMaskCommand(password, context.env);
  if (mask) {
    context.log(mask);
  }

  // Registered before docker run: an interrupted start can still leave the
  // container behind.
  context.cleanups.add(() => {
    const removal = context.run(
      'docker',
      postgresRemoveArguments(containerName),
      { env: context.env, capture: true }
    );
    if (removal.status !== 0) {
      context.log(
        `Could not remove container ${containerName}: ${removal.stderr.trim()}`
      );
    }
  });

  await runStep(
    context,
    `postgres: start ${POSTGRES_IMAGE} on 127.0.0.1`,
    'docker',
    postgresRunArguments(containerName),
    {
      env: { ...context.env, POSTGRES_PASSWORD: password },
      capture: true,
    }
  );
  await waitForPostgres(context, containerName);
  const port = parsePublishedPort(
    (
      await runStep(
        context,
        'postgres: read the loopback port',
        'docker',
        ['port', containerName, '5432/tcp'],
        { env: context.env, capture: true }
      )
    ).stdout
  );
  const postgres = { port, password };
  await runStep(
    context,
    'postgres: create the empty entity database',
    'docker',
    postgresCreateDatabaseArguments(containerName),
    { env: context.env, capture: true }
  );

  await runDatabaseChecks(
    context,
    options,
    databaseEnvironment({
      baseEnv: context.env,
      configDirectory,
      postgres,
    }),
    POSTGRES_ENTITY_DATABASE
  );

  if (!options.writeAllowlist) {
    await runStep(
      context,
      'postgres: manga migration tests',
      process.execPath,
      ['server/test/index.mts', ...POSTGRES_MIGRATION_TESTS],
      {
        env: {
          ...databaseEnvironment({
            baseEnv: context.env,
            configDirectory,
          }),
          SEERR_TEST_POSTGRES_URL: postgresTestUrl(postgres),
        },
      }
    );
  }
};

export const runMigrationChecks = async (
  options,
  dependencies = defaultDependencies()
) => {
  const cleanups = createCleanups(dependencies.log);
  const interruption = new AbortController();
  const context = {
    ...dependencies,
    cleanups,
    interruption: interruption.signal,
  };
  const stopListening = dependencies.onInterrupt(async (signal) => {
    // Another signal while the cleanup runs exits without waiting for it.
    if (interruption.signal.aborted) {
      dependencies.exit(signalExitCode(signal));
      return;
    }

    interruption.abort(new Error(`Interrupted by ${signal}.`));
    dependencies.log(`${signal} received; cleaning up before exiting.`);
    await cleanups.run();
    dependencies.exit(signalExitCode(signal));
  });

  try {
    const configDirectory = dependencies.makeConfigDirectory();
    cleanups.add(() => dependencies.removeConfigDirectory(configDirectory));

    if (options.driver === 'postgres') {
      await runPostgresChecks(context, options, configDirectory);
    } else {
      await runDatabaseChecks(
        context,
        options,
        databaseEnvironment({ baseEnv: dependencies.env, configDirectory }),
        path.join(configDirectory, SQLITE_ENTITY_DATABASE)
      );
    }
  } finally {
    await cleanups.run();
    // A signal that arrived during the last step is still pending. Deliver it
    // while the handler is registered rather than dropping it.
    await nextTurn();
    stopListening();
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

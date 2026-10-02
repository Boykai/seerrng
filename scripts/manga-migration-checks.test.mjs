import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POSTGRES_IMAGE,
  POSTGRES_MIGRATION_TESTS,
  UsageError,
  actionsMaskCommand,
  databaseEnvironment,
  parseArguments,
  parsePublishedPort,
  postgresRunArguments,
  postgresTestUrl,
  runMigrationChecks,
} from './manga-migration-checks.mjs';

const PASSWORD = 'fixture-password/+=';

const fakeDependencies = ({
  env = {},
  failWhen = () => false,
  notReadyAttempts = 0,
} = {}) => {
  const calls = [];
  const logs = [];
  const removed = [];
  let readyChecks = 0;
  let waits = 0;

  return {
    calls,
    logs,
    removed,
    get waits() {
      return waits;
    },
    dependencies: {
      env,
      log: (message) => logs.push(message),
      createPassword: () => PASSWORD,
      createContainerName: () => 'seerrng-manga-migrations-fixture',
      makeConfigDirectory: () => 'config-fixture',
      removeConfigDirectory: (directory) => removed.push(directory),
      wait: async () => {
        waits += 1;
      },
      run: (command, args, options = {}) => {
        calls.push({ command, args, env: options.env });
        if (failWhen(command, args)) {
          return { status: 3, stdout: '', stderr: 'fixture failure' };
        }
        if (command === 'docker' && args.includes('pg_isready')) {
          readyChecks += 1;
          return {
            status: readyChecks > notReadyAttempts ? 0 : 2,
            stdout: '',
            stderr: '',
          };
        }
        if (command === 'docker' && args[0] === 'port') {
          return { status: 0, stdout: '127.0.0.1:55432\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
};

const scriptOf = (call) =>
  call.args.find((arg) => /\.(?:ts|mts|cjs)$/.test(String(arg)));

test('parseArguments accepts a driver and the allowlist flag only', () => {
  assert.deepStrictEqual(parseArguments(['sqlite']), {
    driver: 'sqlite',
    writeAllowlist: false,
  });
  assert.deepStrictEqual(parseArguments(['postgres', '--write-allowlist']), {
    driver: 'postgres',
    writeAllowlist: true,
  });
  assert.throws(() => parseArguments([]), UsageError);
  assert.throws(() => parseArguments(['mysql']), UsageError);
  assert.throws(() => parseArguments(['sqlite', '--force']), UsageError);
});

test('the PostgreSQL container is digest-pinned, loopback-only and gets no password argument', () => {
  assert.match(POSTGRES_IMAGE, /^postgres:[\w.-]+@sha256:[0-9a-f]{64}$/);

  const args = postgresRunArguments('fixture');
  assert.equal(args.at(-1), POSTGRES_IMAGE);
  assert.equal(args[args.indexOf('--publish') + 1], '127.0.0.1::5432');
  assert.equal(args[args.indexOf('--env') + 1], 'POSTGRES_PASSWORD');
  assert.ok(!args.some((arg) => arg.startsWith('POSTGRES_PASSWORD=')));
});

test('parsePublishedPort accepts loopback mappings only', () => {
  assert.equal(parsePublishedPort('127.0.0.1:49153\n'), 49153);
  for (const output of [
    '',
    '0.0.0.0:49153',
    '127.0.0.1:49153\n[::]:49153',
    '127.0.0.1:not-a-port',
  ]) {
    assert.throws(() => parsePublishedPort(output), /127\.0\.0\.1 only/);
  }
});

test('databaseEnvironment isolates the run from the caller database settings', () => {
  const baseEnv = {
    PATH: 'path-fixture',
    NODE_ENV: 'test',
    PRESERVE_DB: 'true',
    DB_TYPE: 'postgres',
    DB_HOST: 'database.invalid',
  };

  assert.deepStrictEqual(
    databaseEnvironment({ baseEnv, configDirectory: 'config-fixture' }),
    {
      PATH: 'path-fixture',
      CONFIG_DIRECTORY: 'config-fixture',
      WITH_MIGRATIONS: 'true',
    }
  );
  assert.deepStrictEqual(
    databaseEnvironment({
      baseEnv,
      configDirectory: 'config-fixture',
      postgres: { port: 55432, password: PASSWORD },
    }),
    {
      PATH: 'path-fixture',
      CONFIG_DIRECTORY: 'config-fixture',
      WITH_MIGRATIONS: 'true',
      DB_TYPE: 'postgres',
      DB_HOST: '127.0.0.1',
      DB_PORT: '55432',
      DB_USER: 'postgres',
      DB_PASS: PASSWORD,
      DB_NAME: 'seerr',
    }
  );
  assert.equal(baseEnv.NODE_ENV, 'test');
});

test('postgresTestUrl encodes the password and masks it only in Actions', () => {
  assert.equal(
    postgresTestUrl({ port: 55432, password: PASSWORD }),
    'postgres://postgres:fixture-password%2F%2B%3D@127.0.0.1:55432/seerr'
  );
  assert.equal(
    actionsMaskCommand(PASSWORD, { GITHUB_ACTIONS: 'true' }),
    `::add-mask::${PASSWORD}`
  );
  assert.equal(actionsMaskCommand(PASSWORD, {}), undefined);
});

test('the SQLite check builds from empty, then runs the round trip and drift check', async () => {
  const fake = fakeDependencies();

  await runMigrationChecks(
    { driver: 'sqlite', writeAllowlist: false },
    fake.dependencies
  );

  assert.deepStrictEqual(fake.calls.map(scriptOf), [
    'server/scripts/prepareTestDb.ts',
    'server/scripts/checkMigrationDrift.ts',
  ]);
  assert.ok(!fake.calls[1].args.includes('--write-allowlist'));
  assert.equal(fake.calls[0].env.CONFIG_DIRECTORY, 'config-fixture');
  assert.equal(fake.calls[0].env.WITH_MIGRATIONS, 'true');
  assert.deepStrictEqual(fake.removed, ['config-fixture']);
});

test('a failing step stops the run and still removes the config directory', async () => {
  const fake = fakeDependencies({
    failWhen: (_command, args) =>
      args.includes('server/scripts/checkMigrationDrift.ts'),
  });

  await assert.rejects(
    runMigrationChecks(
      { driver: 'sqlite', writeAllowlist: false },
      fake.dependencies
    ),
    /sqlite: migration round trip and drift check failed \(exit 3\)/
  );
  assert.deepStrictEqual(fake.removed, ['config-fixture']);
});

test('the PostgreSQL check waits for readiness, runs the tests and removes the container', async () => {
  const fake = fakeDependencies({
    env: { GITHUB_ACTIONS: 'true' },
    notReadyAttempts: 2,
  });

  await runMigrationChecks(
    { driver: 'postgres', writeAllowlist: false },
    fake.dependencies
  );

  assert.equal(fake.waits, 2);
  assert.equal(fake.logs[0], `::add-mask::${PASSWORD}`);
  const [start] = fake.calls;
  assert.equal(start.env.POSTGRES_PASSWORD, PASSWORD);
  assert.ok(
    fake.calls.every((call) =>
      call.args.every((arg) => !String(arg).includes(PASSWORD))
    ),
    'the password must never appear on a command line'
  );

  const nodeCalls = fake.calls.filter((call) => call.command !== 'docker');
  assert.deepStrictEqual(nodeCalls.map(scriptOf), [
    'server/scripts/prepareTestDb.ts',
    'server/scripts/checkMigrationDrift.ts',
    'server/test/index.mts',
  ]);
  assert.equal(nodeCalls[0].env.DB_TYPE, 'postgres');
  assert.equal(nodeCalls[0].env.DB_PORT, '55432');
  assert.deepStrictEqual(nodeCalls[2].args.slice(1), POSTGRES_MIGRATION_TESTS);
  assert.equal(
    nodeCalls[2].env.SEERR_TEST_POSTGRES_URL,
    postgresTestUrl({ port: 55432, password: PASSWORD })
  );
  assert.equal(nodeCalls[2].env.DB_TYPE, undefined);

  assert.deepStrictEqual(fake.calls.at(-1).args, [
    'rm',
    '--force',
    '--volumes',
    'seerrng-manga-migrations-fixture',
  ]);
  assert.deepStrictEqual(fake.removed, ['config-fixture']);
});

test('the PostgreSQL container is removed when a check fails', async () => {
  const fake = fakeDependencies({
    failWhen: (_command, args) =>
      args.includes('server/scripts/prepareTestDb.ts'),
  });

  await assert.rejects(
    runMigrationChecks(
      { driver: 'postgres', writeAllowlist: false },
      fake.dependencies
    ),
    /postgres: build the database from empty with migrations failed/
  );
  assert.deepStrictEqual(fake.calls.at(-1).args.slice(0, 3), [
    'rm',
    '--force',
    '--volumes',
  ]);
  assert.deepStrictEqual(fake.removed, ['config-fixture']);
});

test('writing the allowlist formats it and skips the migration tests', async () => {
  const fake = fakeDependencies();

  await runMigrationChecks(
    { driver: 'postgres', writeAllowlist: true },
    fake.dependencies
  );

  const nodeCalls = fake.calls.filter((call) => call.command !== 'docker');
  assert.deepStrictEqual(nodeCalls.map(scriptOf), [
    'server/scripts/prepareTestDb.ts',
    'server/scripts/checkMigrationDrift.ts',
    nodeCalls[2].args[0],
  ]);
  assert.ok(nodeCalls[1].args.includes('--write-allowlist'));
  assert.match(nodeCalls[2].args[0], /prettier\.cjs$/);
  assert.deepStrictEqual(nodeCalls[2].args.slice(1), [
    '--write',
    'server/scripts/migration-drift-allowlist/postgres.json',
  ]);
  assert.equal(nodeCalls.length, 3);
});

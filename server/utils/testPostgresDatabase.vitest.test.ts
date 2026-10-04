import { selectTestDataSourceOptions } from '@server/datasource';
import { describe, expect, it } from 'vitest';
import {
  TEST_POSTGRES_DATABASE_VARIABLE,
  TEST_POSTGRES_URL_VARIABLE,
  isTestPostgresDatabaseName,
  parseTestPostgresUrl,
} from './testPostgresDatabase';

const SECRET = 'not-a-real-secret';
const LOOPBACK_URL = `postgres://seerr:${SECRET}@127.0.0.1:55432/seerr`;
const DATABASE = 'seerr_test_0a1b2c3d';

const liveEnvironment = (
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv => {
  const environment: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    DB_TYPE: 'postgres',
    [TEST_POSTGRES_URL_VARIABLE]: LOOPBACK_URL,
    [TEST_POSTGRES_DATABASE_VARIABLE]: DATABASE,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== undefined)
  ) as NodeJS.ProcessEnv;
};

const thrownMessage = (callback: () => unknown): string => {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the call to throw.');
};

describe('test database selection', () => {
  it('uses the run database on the loopback server when every condition holds', () => {
    const options = selectTestDataSourceOptions(liveEnvironment());

    expect(options).toMatchObject({
      type: 'postgres',
      host: '127.0.0.1',
      port: 55432,
      username: 'seerr',
      password: SECRET,
      database: DATABASE,
      ssl: false,
      synchronize: false,
      dropSchema: false,
      migrationsRun: false,
    });
    expect(options).not.toHaveProperty('url');
    expect(
      (options as { migrations: string[] }).migrations.every((file) =>
        file.startsWith('server/migration/postgres/')
      )
    ).toBe(true);
  });

  it.each([
    ['NODE_ENV is not test', { NODE_ENV: 'development' }],
    ['DB_TYPE is not postgres', { DB_TYPE: undefined }],
    ['the server URL is missing', { [TEST_POSTGRES_URL_VARIABLE]: undefined }],
    ['Vitest is running', { VITEST: 'true' }],
    [
      'no run database is named',
      { [TEST_POSTGRES_DATABASE_VARIABLE]: undefined },
    ],
  ])('stays on in-memory SQLite when %s', (_condition, overrides) => {
    expect(
      selectTestDataSourceOptions(liveEnvironment(overrides))
    ).toMatchObject({ type: 'better-sqlite3', database: ':memory:' });
  });

  it.each([
    `postgres://seerr:${SECRET}@db.example.invalid:5432/seerr`,
    `postgres://seerr:${SECRET}@192.0.2.10/seerr`,
    `postgresql://seerr:${SECRET}@[2001:db8::10]:5432/seerr`,
  ])('refuses a server that is not on loopback without echoing it', (url) => {
    const message = thrownMessage(() =>
      selectTestDataSourceOptions(
        liveEnvironment({ [TEST_POSTGRES_URL_VARIABLE]: url })
      )
    );

    expect(message).toContain(TEST_POSTGRES_URL_VARIABLE);
    expect(message).not.toContain(SECRET);
    expect(message).not.toMatch(/example\.invalid|192\.0\.2|2001:db8/);
  });

  it('refuses a database that was not created for a test run', () => {
    const message = thrownMessage(() =>
      selectTestDataSourceOptions(
        liveEnvironment({ [TEST_POSTGRES_DATABASE_VARIABLE]: 'seerr' })
      )
    );

    expect(message).toContain(TEST_POSTGRES_DATABASE_VARIABLE);
    expect(message).not.toContain(SECRET);
  });
});

describe('test PostgreSQL URL parsing', () => {
  it.each([
    ['postgres://127.0.0.1/seerr', '127.0.0.1'],
    ['postgresql://LOCALHOST:5433/seerr', 'localhost'],
    ['postgres://[::1]:5434/seerr', '::1'],
  ])('accepts the loopback server in %s', (url, host) => {
    expect(parseTestPostgresUrl(url).host).toBe(host);
  });

  it('defaults the port and adds no credentials of its own', () => {
    expect(parseTestPostgresUrl('postgres://127.0.0.1')).toEqual({
      host: '127.0.0.1',
      port: 5432,
      username: undefined,
      password: undefined,
      database: undefined,
    });
  });

  it('decodes escaped credentials and the database name', () => {
    expect(
      parseTestPostgresUrl('postgres://seerr%40run:p%3Ass%2Fw@127.0.0.1/db%5Fx')
    ).toMatchObject({
      username: 'seerr@run',
      password: 'p:ss/w',
      database: 'db_x',
    });
  });

  it.each([
    'not a url',
    `mysql://seerr:${SECRET}@127.0.0.1/seerr`,
    `postgres://seerr:${SECRET}@127.0.0.1:99999/seerr`,
    `postgres://seerr:%E0%A4%A@127.0.0.1/seerr`,
  ])('refuses an unusable URL without echoing it (%#)', (url) => {
    const message = thrownMessage(() => parseTestPostgresUrl(url));

    expect(message).toContain(TEST_POSTGRES_URL_VARIABLE);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(url);
  });

  it('recognises only database names made for a test run', () => {
    expect(isTestPostgresDatabaseName('seerr_test_0a1b2c3d')).toBe(true);
    expect(isTestPostgresDatabaseName('seerr')).toBe(false);
    expect(isTestPostgresDatabaseName('seerr_test_')).toBe(false);
    expect(isTestPostgresDatabaseName('seerr_test_ab"; DROP')).toBe(false);
    expect(isTestPostgresDatabaseName('SEERR_TEST_AB')).toBe(false);
  });
});

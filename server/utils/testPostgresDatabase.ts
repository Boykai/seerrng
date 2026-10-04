// Live PostgreSQL tests use a database created for the run on a server
// reached over loopback. Errors name the variable and never its value.
export const TEST_POSTGRES_URL_VARIABLE = 'SEERR_TEST_POSTGRES_URL';
export const TEST_POSTGRES_DATABASE_VARIABLE = 'SEERR_TEST_POSTGRES_DATABASE';

const TEST_POSTGRES_DATABASE_PATTERN = /^seerr_test_[0-9a-f_]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface TestPostgresServer {
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
}

const invalidUrl = (): Error =>
  new Error(`${TEST_POSTGRES_URL_VARIABLE} is not a valid URL.`);

const decodePart = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidUrl();
  }
};

export const parseTestPostgresUrl = (value: string): TestPostgresServer => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl();
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${TEST_POSTGRES_URL_VARIABLE} must be a postgres URL.`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `${TEST_POSTGRES_URL_VARIABLE} must name a loopback PostgreSQL server.`
    );
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw invalidUrl();
  }
  const database = decodePart(url.pathname.replace(/^\//, ''));
  return {
    host,
    port,
    username: url.username ? decodePart(url.username) : undefined,
    password: url.password ? decodePart(url.password) : undefined,
    database: database || undefined,
  };
};

export const isTestPostgresDatabaseName = (name: string): boolean =>
  TEST_POSTGRES_DATABASE_PATTERN.test(name);

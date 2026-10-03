import {
  TEST_POSTGRES_DATABASE_VARIABLE,
  TEST_POSTGRES_URL_VARIABLE,
  isTestPostgresDatabaseName,
  parseTestPostgresUrl,
  type TestPostgresServer,
} from '@server/utils/testPostgresDatabase';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { after, before, beforeEach } from 'node:test';
import { DataSource } from 'typeorm';

const postgresUrl = process.env[TEST_POSTGRES_URL_VARIABLE];

// Only Node's test runner can switch the application to PostgreSQL: Vitest
// keeps it on the in-memory SQLite database.
export const runsOnPostgres = Boolean(postgresUrl) && !process.env.VITEST;

export interface SocketTarget {
  host: string;
  port?: number;
  path?: string;
}

// net.Socket#connect takes a port and host, an options object, or the
// normalized array that net.connect passes on.
export const getSocketTarget = (args: unknown[]): SocketTarget => {
  const [first, second] = args;
  if (Array.isArray(first)) {
    return getSocketTarget(first);
  }
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof options.path === 'string') {
      return { host: '', path: options.path };
    }
    return {
      host: typeof options.host === 'string' ? options.host : 'localhost',
      port: Number(options.port),
    };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    return { host: '', path: first };
  }
  return {
    host: typeof second === 'string' ? second : 'localhost',
    port: Number(first),
  };
};

export interface PostgresApplication {
  readonly dataSource: DataSource;
  readonly server: TestPostgresServer;
  // Lets the file reach a server it started on 127.0.0.1 itself.
  allowPort(port: number): void;
  // Settles when the database is ready. Node starts a file's top-level
  // before hooks together, so a file's own hook awaits this first.
  ready(): Promise<void>;
}

const LOCAL_SERVER_HOST = '127.0.0.1';

const targetKey = ({ host, port }: SocketTarget): string =>
  `${host.replace(/^\[(.*)\]$/, '$1')}:${port}`;

const TABLES_KEPT_BETWEEN_TESTS = ['migrations', 'typeorm_metadata'];

// Points the application at a database created for this test file on the
// loopback server named by SEERR_TEST_POSTGRES_URL, migrates it from empty
// and seeds the test users. Every table but the migration history is emptied
// before each test, and the database is dropped when the file ends, whatever
// its result. The file may connect only to that server and to ports it
// allows; anything else fails the file.
export const setupPostgresApplication = (): PostgresApplication => {
  let dataSource: DataSource | undefined;
  let server: TestPostgresServer | undefined;
  let admin: DataSource | undefined;
  let databaseName: string | undefined;
  const allowedTargets = new Set<string>();
  const targets: SocketTarget[] = [];
  const originalConnect = net.Socket.prototype.connect;
  let settleReady: (error?: unknown) => void = () => undefined;
  const readiness = new Promise<void>((resolve, reject) => {
    settleReady = (error) => (error === undefined ? resolve() : reject(error));
  });
  // The failing hook reports the error; this only stops an unawaited
  // rejection from ending the process.
  readiness.catch(() => undefined);

  const application: PostgresApplication = {
    get dataSource() {
      assert.ok(dataSource, 'The PostgreSQL application is not ready.');
      return dataSource;
    },
    get server() {
      assert.ok(server, 'The PostgreSQL application is not ready.');
      return server;
    },
    allowPort(port: number) {
      allowedTargets.add(targetKey({ host: LOCAL_SERVER_HOST, port }));
    },
    ready: () => readiness,
  };

  if (!runsOnPostgres || !postgresUrl) {
    settleReady();
    return application;
  }

  const seedUsers = async () => {
    const { seedTestUsers } = await import('@server/utils/seedTestDb');
    await seedTestUsers();
  };

  const start = async () => {
    server = parseTestPostgresUrl(postgresUrl);
    allowedTargets.add(targetKey(server));
    net.Socket.prototype.connect = function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      targets.push(getSocketTarget(args));
      return (originalConnect as (...values: unknown[]) => net.Socket).apply(
        this,
        args
      );
    } as typeof originalConnect;

    admin = await new DataSource({
      type: 'postgres',
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      database: server.database ?? 'postgres',
      ssl: false,
      logging: false,
      entities: [],
      migrations: [],
      subscribers: [],
    }).initialize();
    const name = `seerr_test_${randomBytes(8).toString('hex')}`;
    assert.ok(isTestPostgresDatabaseName(name));
    await admin.query(`CREATE DATABASE "${name}"`);
    databaseName = name;

    process.env.DB_TYPE = 'postgres';
    process.env[TEST_POSTGRES_DATABASE_VARIABLE] = name;
    const { isPgsql } = await import('@server/utils/dbType');
    const { default: applicationDataSource } =
      await import('@server/datasource');
    const options = applicationDataSource.options as {
      type: string;
      database?: unknown;
    };
    assert.ok(
      isPgsql && options.type === 'postgres' && options.database === name,
      `The application database is not the one created for this run (driver ${options.type}, postgres flag ${isPgsql}, run database ${options.database === name}).`
    );
    await applicationDataSource.initialize();
    dataSource = applicationDataSource;
    await dataSource.runMigrations();
    await seedUsers();
  };

  before(async () => {
    try {
      await start();
      settleReady();
    } catch (error) {
      settleReady(error);
      throw error;
    }
  });

  beforeEach(async () => {
    const tables: { tablename: string }[] = await application.dataSource.query(
      `SELECT "tablename" FROM "pg_tables"
       WHERE "schemaname" = current_schema() AND NOT ("tablename" = ANY($1))`,
      [TABLES_KEPT_BETWEEN_TESTS]
    );
    if (tables.length > 0) {
      await application.dataSource.query(
        `TRUNCATE TABLE ${tables
          .map(({ tablename }) => `"${tablename.replace(/"/g, '""')}"`)
          .join(', ')} RESTART IDENTITY CASCADE`
      );
    }
    await seedUsers();
  });

  after(async () => {
    try {
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    } finally {
      try {
        if (admin?.isInitialized && databaseName) {
          await admin.query(
            `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`
          );
        }
      } finally {
        if (admin?.isInitialized) {
          await admin.destroy();
        }
        net.Socket.prototype.connect = originalConnect;
        delete process.env[TEST_POSTGRES_DATABASE_VARIABLE];
      }
    }
    assert.deepStrictEqual(
      targets.filter(
        (target) =>
          target.path !== undefined || !allowedTargets.has(targetKey(target))
      ),
      [],
      'A test connected somewhere other than the test database or its own server.'
    );
  });

  return application;
};

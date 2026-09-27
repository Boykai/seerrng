import dataSource from '@server/datasource';
import logger from '@server/logger';
import { getMetadataArgsStorage } from 'typeorm';
import './setup';

// The test runner must not inherit the preview's NODE_ENV=development and
// CONFIG_DIRECTORY. Refuse disk-backed databases before any suite can seed
// or reset them, even when tests are launched from a development container.
if (
  dataSource.options.type !== 'better-sqlite3' ||
  dataSource.options.database !== ':memory:'
) {
  throw new Error(
    'Vitest requires an isolated in-memory database. Set NODE_ENV=test before starting the runner.'
  );
}

import.meta.glob(['../entity/*.ts', '!../entity/*.test.ts'], { eager: true });
import.meta.glob(['../subscriber/*.ts', '!../subscriber/*.test.ts'], {
  eager: true,
});

const metadata = getMetadataArgsStorage();
dataSource.setOptions({
  entities: metadata.tables.map(({ target }) => target),
  migrations: [],
  subscribers: metadata.entitySubscribers.map(({ target }) => target),
});

process.env.NODE_ENV = 'test';

if (process.env.VERBOSE !== 'true') {
  logger.silent = true;
}

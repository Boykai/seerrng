import dataSource from '@server/datasource';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { QueryRunner } from 'typeorm';

/**
 * Records, by table, each INSERT the database receives from now until the
 * test restores its mocks.
 */
export const recordInserts = (): ReadonlyMap<string, readonly string[]> => {
  const inserts = new Map<string, string[]>();
  const { logger } = dataSource;
  const logQuery = logger.logQuery.bind(logger);
  mock.method(
    logger,
    'logQuery',
    (query: string, parameters?: unknown[], queryRunner?: QueryRunner) => {
      const table = /^INSERT INTO "([^"]+)"/.exec(query)?.[1];
      if (table) inserts.set(table, [...(inserts.get(table) ?? []), query]);
      return logQuery(query, parameters, queryRunner);
    }
  );
  return inserts;
};

/**
 * Asserts that each table received an insert, and that every insert it
 * received skips a row only when it conflicts on the given key.
 */
export const assertConflictTargets = (
  inserts: ReadonlyMap<string, readonly string[]>,
  keys: Readonly<Record<string, readonly string[]>>
): void => {
  for (const [table, key] of Object.entries(keys)) {
    const queries = inserts.get(table) ?? [];
    assert.ok(queries.length > 0, `Nothing was inserted into ${table}.`);
    const target = key.map((column) => `"${column}"`).join(', ');
    for (const query of queries) {
      assert.ok(
        query.includes(`ON CONFLICT ( ${target} ) DO NOTHING`),
        `${table} received: ${query}`
      );
    }
  }
};

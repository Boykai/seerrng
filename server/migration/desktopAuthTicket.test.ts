import type { Table, TableIndex } from 'typeorm';
import { DataSource, type QueryRunner } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { AddDesktopAuthTickets1790900000000 as PostgresMigration } from './postgres/1790900000000-AddDesktopAuthTickets';
import { AddDesktopAuthTickets1790900000000 as SqliteMigration } from './sqlite/1790900000000-AddDesktopAuthTickets';

describe('desktop authentication ticket migration', () => {
  it('creates the SQLite ticket table with a unique digest and rolls back cleanly', async () => {
    const source = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
    }).initialize();
    const runner = source.createQueryRunner();
    const migration = new SqliteMigration();

    try {
      await migration.up(runner);
      const table = await runner.getTable('desktop_auth_ticket');
      expect(table?.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'userId',
          'sessionId',
          'credentialVersion',
          'jellyfinUserId',
          'jellyfinAuthorityKey',
          'ticketDigest',
          'challengeDigest',
          'protocolVersion',
          'expiresAt',
          'createdAt',
          'consumedAt',
        ])
      );
      expect(
        table?.indices.find(
          (index) => index.name === 'IDX_desktop_auth_ticket_digest_unique'
        )?.isUnique
      ).toBe(true);
      await migration.down(runner);
      expect(await runner.hasTable('desktop_auth_ticket')).toBe(false);
    } finally {
      await runner.release();
      await source.destroy();
    }
  });

  it('keeps the PostgreSQL migration columns and index definitions aligned', async () => {
    const createdTables: Table[] = [];
    const createdIndexes: TableIndex[] = [];
    const fakeRunner = {
      createTable: async (table: Table) => {
        createdTables.push(table);
      },
      createIndex: async (_table: string, index: TableIndex) => {
        createdIndexes.push(index);
      },
    } as QueryRunner;

    await new PostgresMigration().up(fakeRunner);
    expect(createdTables[0].columns.map((column) => column.name)).toContain(
      'jellyfinAuthorityKey'
    );
    expect(
      createdTables[0].columns.find((column) => column.name === 'expiresAt')
        ?.type
    ).toBe('timestamp with time zone');
    expect(
      createdIndexes.find(
        (index) => index.name === 'IDX_desktop_auth_ticket_digest_unique'
      )?.isUnique
    ).toBe(true);
    expect(new PostgresMigration().name).toBe(new SqliteMigration().name);
  });
});

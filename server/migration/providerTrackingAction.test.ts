import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { AddProviderTrackingActions1790630402000 as PostgresMigration } from './postgres/1790630402000-AddProviderTrackingActions';
import { AddProviderTrackingActions1790630402000 as SqliteMigration } from './sqlite/1790630402000-AddProviderTrackingActions';

describe('provider tracking action migration', () => {
  it('creates a user-scoped idempotency table and reverses cleanly', async () => {
    const source = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
    }).initialize();
    const runner = source.createQueryRunner();
    try {
      await runner.query('CREATE TABLE user (id integer primary key)');
      const migration = new SqliteMigration();
      await migration.up(runner);
      const table = await runner.getTable('provider_tracking_action');
      expect(table?.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'userId',
          'requestId',
          'provider',
          'fingerprint',
          'state',
          'intent',
          'createdAt',
          'completedAt',
        ])
      );
      expect(
        table?.indices.find(
          (index) => index.name === 'IDX_provider_tracking_action_user_request'
        )?.isUnique
      ).toBe(true);
      expect(table?.foreignKeys[0]).toMatchObject({
        columnNames: ['userId'],
        referencedTableName: 'user',
        onDelete: 'CASCADE',
      });
      await migration.down(runner);
      expect(await runner.hasTable('provider_tracking_action')).toBe(false);
      expect(new PostgresMigration().name).toBe(migration.name);
    } finally {
      await runner.release();
      await source.destroy();
    }
  });
});

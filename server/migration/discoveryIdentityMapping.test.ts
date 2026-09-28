import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { AddDiscoveryIdentityMappings1790630404000 as PostgresMigration } from './postgres/1790630404000-AddDiscoveryIdentityMappings';
import { AddDiscoveryIdentityMappings1790630404000 as SqliteMigration } from './sqlite/1790630404000-AddDiscoveryIdentityMappings';

describe('discovery identity mapping migration', () => {
  it('creates a private, unique mapping table and reverses cleanly', async () => {
    const source = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
    }).initialize();
    const runner = source.createQueryRunner();
    try {
      await runner.query('CREATE TABLE user (id integer primary key)');
      const migration = new SqliteMigration();
      await migration.up(runner);
      const table = await runner.getTable('discovery_identity_mapping');
      expect(table?.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'userId',
          'identity',
          'tmdbId',
          'mediaType',
          'updatedAt',
        ])
      );
      expect(
        table?.indices.find(
          (index) =>
            index.name === 'IDX_discovery_identity_mapping_user_identity'
        )?.isUnique
      ).toBe(true);
      expect(table?.foreignKeys[0]).toMatchObject({
        columnNames: ['userId'],
        referencedTableName: 'user',
        onDelete: 'CASCADE',
      });
      await migration.down(runner);
      expect(await runner.hasTable('discovery_identity_mapping')).toBe(false);
      expect(new PostgresMigration().name).toBe(migration.name);
    } finally {
      await runner.release();
      await source.destroy();
    }
  });
});

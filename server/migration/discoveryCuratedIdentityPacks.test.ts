import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { AddDiscoveryCuratedIdentityPacks1790630405000 as PostgresMigration } from './postgres/1790630405000-AddDiscoveryCuratedIdentityPacks';
import { AddDiscoveryCuratedIdentityPacks1790630405000 as SqliteMigration } from './sqlite/1790630405000-AddDiscoveryCuratedIdentityPacks';

describe('curated discovery identity pack migration', () => {
  it('creates an instance-wide pack catalog with globally unique identities', async () => {
    const source = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
    }).initialize();
    const runner = source.createQueryRunner();
    try {
      const migration = new SqliteMigration();
      await migration.up(runner);
      const pack = await runner.getTable('discovery_curated_identity_pack');
      const mapping = await runner.getTable(
        'discovery_curated_identity_mapping'
      );
      expect(pack?.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['packId', 'name', 'version', 'updatedAt'])
      );
      expect(mapping?.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'packId',
          'identity',
          'tmdbId',
          'mediaType',
          'updatedAt',
        ])
      );
      expect(
        mapping?.indices.find(
          (index) =>
            index.name === 'IDX_discovery_curated_identity_mapping_identity'
        )?.isUnique
      ).toBe(true);
      expect(mapping?.foreignKeys[0]).toMatchObject({
        columnNames: ['packId'],
        referencedTableName: 'discovery_curated_identity_pack',
        onDelete: 'CASCADE',
      });
      await migration.down(runner);
      expect(await runner.hasTable('discovery_curated_identity_mapping')).toBe(
        false
      );
      expect(await runner.hasTable('discovery_curated_identity_pack')).toBe(
        false
      );
      expect(new PostgresMigration().name).toBe(migration.name);
    } finally {
      await runner.release();
      await source.destroy();
    }
  });
});

import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { AddCollectionLink1790000000000 as PostgresMigration } from './postgres/1790000000000-AddCollectionLink';
import { AddCollectionLink1790000000000 } from './sqlite/1790000000000-AddCollectionLink';
import { CollectionSourcesAndSelections1790012000000 } from './sqlite/1790012000000-CollectionSourcesAndSelections';

describe('collection link migration', () => {
  it('preserves existing links without converting past selections into a future allowlist', async () => {
    const source = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
    }).initialize();
    const runner = source.createQueryRunner();
    try {
      await new AddCollectionLink1790000000000().up(runner);
      await runner.query(
        'INSERT INTO collection_link (id, collectionId, serverId, libraryId, title, remoteId, enabled, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['test', 55, 'plex', '1', 'Collection', '900', 1, 'active']
      );
      const migration = new CollectionSourcesAndSelections1790012000000();
      await migration.up(runner);
      const [saved] = await runner.query('SELECT * FROM collection_link');
      expect(saved).toMatchObject({
        collectionId: 55,
        remoteId: '900',
        enabled: 1,
        sourceType: 'movie',
        sourceId: null,
        seenIds: null,
      });
      await migration.down(runner);
      expect(
        (await runner.query('SELECT * FROM collection_link'))[0]
      ).toMatchObject({ remoteId: '900', enabled: 1 });
    } finally {
      await runner.release();
      await source.destroy();
    }
  });
  it('creates a persistent independent link table and reverses cleanly', async () => {
    const source = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
    }).initialize();
    const runner = source.createQueryRunner();
    try {
      const migration = new AddCollectionLink1790000000000();
      await migration.up(runner);
      const table = await runner.getTable('collection_link');
      expect(table?.columns.map((column) => column.name)).toContain('remoteId');
      expect(table?.foreignKeys).toHaveLength(0);
      expect(table?.indices[0].columnNames).toEqual(['collectionId']);
      await migration.down(runner);
      expect(await runner.hasTable('collection_link')).toBe(false);
      expect(PostgresMigration).toBe(AddCollectionLink1790000000000);
    } finally {
      await runner.release();
      await source.destroy();
    }
  });
});

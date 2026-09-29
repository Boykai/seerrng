import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { AddEpisodeWatchAhead1790726400000 as PostgresMigration } from './postgres/1790726400000-AddEpisodeWatchAhead';
import { AddEpisodeWatchAhead1790726400000 as SqliteMigration } from './sqlite/1790726400000-AddEpisodeWatchAhead';

describe('episode watch-ahead migration', () => {
  it('adds durable request progress and quota attribution columns', async () => {
    const source = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
    }).initialize();
    const runner = source.createQueryRunner();
    try {
      await runner.query(
        'CREATE TABLE media_request (id integer primary key, status integer not null)'
      );
      const migration = new SqliteMigration();
      await migration.up(runner);

      const request = await runner.getTable('media_request');
      expect(request?.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'watchAheadEpisodeCount',
          'watchAheadLastSeason',
          'watchAheadLastEpisode',
          'watchAheadLastReconciledAt',
          'watchAheadParentRequestId',
        ])
      );
      expect(
        request?.indices.find(
          (index) => index.name === 'IDX_media_request_watch_ahead_parent'
        )?.columnNames
      ).toEqual(['watchAheadParentRequestId']);
      expect(request?.foreignKeys).toContainEqual(
        expect.objectContaining({
          name: 'FK_media_request_watch_ahead_parent',
          columnNames: ['watchAheadParentRequestId'],
          referencedTableName: 'media_request',
          onDelete: 'CASCADE',
        })
      );

      await migration.down(runner);
      expect(
        (await runner.getTable('media_request'))?.columns.map(
          (column) => column.name
        )
      ).not.toEqual(
        expect.arrayContaining([
          'watchAheadEpisodeCount',
          'watchAheadLastSeason',
          'watchAheadLastEpisode',
          'watchAheadLastReconciledAt',
          'watchAheadParentRequestId',
        ])
      );
      expect(new PostgresMigration().name).toBe(migration.name);
    } finally {
      await runner.release();
      await source.destroy();
    }
  });
});

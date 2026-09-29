import {
  TableColumn,
  TableForeignKey,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddEpisodeWatchAhead1790726400000 implements MigrationInterface {
  name = 'AddEpisodeWatchAhead1790726400000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.addColumns('media_request', [
      new TableColumn({
        name: 'watchAheadEpisodeCount',
        type: 'integer',
        default: 0,
      }),
      new TableColumn({
        name: 'watchAheadLastSeason',
        type: 'integer',
        isNullable: true,
      }),
      new TableColumn({
        name: 'watchAheadLastEpisode',
        type: 'integer',
        isNullable: true,
      }),
      new TableColumn({
        name: 'watchAheadLastReconciledAt',
        type: 'integer',
        isNullable: true,
      }),
      new TableColumn({
        name: 'watchAheadParentRequestId',
        type: 'integer',
        isNullable: true,
      }),
    ]);
    await runner.createIndex(
      'media_request',
      new TableIndex({
        name: 'IDX_media_request_watch_ahead_parent',
        columnNames: ['watchAheadParentRequestId'],
      })
    );
    await runner.createForeignKey(
      'media_request',
      new TableForeignKey({
        name: 'FK_media_request_watch_ahead_parent',
        columnNames: ['watchAheadParentRequestId'],
        referencedTableName: 'media_request',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      })
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('media_request');
    const foreignKey = table?.foreignKeys.find(
      (item) => item.name === 'FK_media_request_watch_ahead_parent'
    );
    if (foreignKey) {
      await runner.dropForeignKey('media_request', foreignKey);
    }
    const index = table?.indices.find(
      (item) => item.name === 'IDX_media_request_watch_ahead_parent'
    );
    if (index) {
      await runner.dropIndex('media_request', index);
    }
    await runner.dropColumns('media_request', [
      'watchAheadParentRequestId',
      'watchAheadLastReconciledAt',
      'watchAheadLastEpisode',
      'watchAheadLastSeason',
      'watchAheadEpisodeCount',
    ]);
  }
}

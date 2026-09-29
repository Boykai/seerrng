import {
  Table,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddReleaseCalendarHistory1790812800000 implements MigrationInterface {
  name = 'AddReleaseCalendarHistory1790812800000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'release_calendar_snapshot',
        columns: [
          {
            name: 'eventId',
            type: 'varchar',
            length: '512',
            isPrimary: true,
          },
          { name: 'startsAt', type: 'varchar', length: '32' },
          { name: 'allDay', type: 'boolean' },
          { name: 'observedAt', type: 'varchar', length: '32' },
          { name: 'history', type: 'text', default: "'[]'" },
        ],
      })
    );
    await runner.createIndex(
      'release_calendar_snapshot',
      new TableIndex({
        name: 'IDX_release_calendar_snapshot_observed_at',
        columnNames: ['observedAt'],
      })
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('release_calendar_snapshot');
  }
}

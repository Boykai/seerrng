import {
  Table,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';
export class AddQueueInterventions1790630401000 implements MigrationInterface {
  name = 'AddQueueInterventions1790630401000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'queue_intervention',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'identity', type: 'varchar' },
          { name: 'authority', type: 'varchar' },
          { name: 'serviceType', type: 'varchar' },
          { name: 'serviceName', type: 'varchar' },
          { name: 'title', type: 'varchar' },
          { name: 'serviceId', type: 'integer' },
          { name: 'queueId', type: 'integer' },
          { name: 'downloadId', type: 'varchar', isNullable: true },
          { name: 'warnings', type: 'text' },
          { name: 'actions', type: 'text', default: "'[]'" },
          { name: 'state', type: 'varchar', default: "'active'" },
          { name: 'resolution', type: 'varchar', isNullable: true },
          { name: 'actorId', type: 'integer', isNullable: true },
          { name: 'commandId', type: 'integer', isNullable: true },
          { name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
          {
            name: 'lastSeenAt',
            type: 'datetime',
            default: 'CURRENT_TIMESTAMP',
          },
          { name: 'actionAt', type: 'datetime', isNullable: true },
          { name: 'resolvedAt', type: 'datetime', isNullable: true },
        ],
      })
    );
    await runner.createIndex(
      'queue_intervention',
      new TableIndex({
        name: 'IDX_queue_intervention_identity',
        columnNames: ['identity'],
        isUnique: true,
      })
    );
    await runner.createIndex(
      'queue_intervention',
      new TableIndex({
        name: 'IDX_queue_intervention_state_seen',
        columnNames: ['state', 'lastSeenAt'],
      })
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('queue_intervention');
  }
}

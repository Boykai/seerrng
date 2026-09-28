import {
  Table,
  TableForeignKey,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';
export class AddProviderTrackingActions1790630402000 implements MigrationInterface {
  name = 'AddProviderTrackingActions1790630402000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'provider_tracking_action',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'userId', type: 'integer' },
          { name: 'requestId', type: 'varchar' },
          { name: 'provider', type: 'varchar' },
          { name: 'fingerprint', type: 'varchar' },
          { name: 'state', type: 'varchar' },
          { name: 'intent', type: 'text' },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          { name: 'completedAt', type: 'timestamp', isNullable: true },
        ],
      })
    );
    await runner.createIndex(
      'provider_tracking_action',
      new TableIndex({
        name: 'IDX_provider_tracking_action_user_request',
        columnNames: ['userId', 'requestId'],
        isUnique: true,
      })
    );
    await runner.createIndex(
      'provider_tracking_action',
      new TableIndex({
        name: 'IDX_provider_tracking_action_created',
        columnNames: ['createdAt'],
      })
    );
    await runner.createForeignKey(
      'provider_tracking_action',
      new TableForeignKey({
        columnNames: ['userId'],
        referencedTableName: 'user',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      })
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('provider_tracking_action');
  }
}

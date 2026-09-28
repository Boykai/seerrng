import {
  Table,
  TableForeignKey,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddDiscoveryIdentityMappings1790630404000 implements MigrationInterface {
  name = 'AddDiscoveryIdentityMappings1790630404000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'discovery_identity_mapping',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'userId', type: 'integer' },
          { name: 'identity', type: 'varchar', length: '256' },
          { name: 'tmdbId', type: 'integer' },
          { name: 'mediaType', type: 'varchar' },
          { name: 'updatedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
        ],
      })
    );
    await runner.createIndex(
      'discovery_identity_mapping',
      new TableIndex({
        name: 'IDX_discovery_identity_mapping_user_identity',
        columnNames: ['userId', 'identity'],
        isUnique: true,
      })
    );
    await runner.createIndex(
      'discovery_identity_mapping',
      new TableIndex({
        name: 'IDX_discovery_identity_mapping_user_updated',
        columnNames: ['userId', 'updatedAt'],
      })
    );
    await runner.createForeignKey(
      'discovery_identity_mapping',
      new TableForeignKey({
        columnNames: ['userId'],
        referencedTableName: 'user',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      })
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('discovery_identity_mapping');
  }
}

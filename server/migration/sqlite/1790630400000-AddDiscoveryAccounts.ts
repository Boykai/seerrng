import {
  Table,
  TableForeignKey,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddDiscoveryAccounts1790630400000 implements MigrationInterface {
  name = 'AddDiscoveryAccounts1790630400000';
  public async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'discovery_account',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'userId', type: 'integer' },
          { name: 'provider', type: 'varchar' },
          { name: 'clientId', type: 'varchar' },
          { name: 'accessToken', type: 'text' },
          { name: 'refreshToken', type: 'text', isNullable: true },
          { name: 'expiresAt', type: 'integer', isNullable: true },
          { name: 'providerUserId', type: 'varchar', default: "''" },
          { name: 'username', type: 'varchar', default: "''" },
          { name: 'allowWrites', type: 'boolean', default: false },
          { name: 'linkedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
        ],
      })
    );
    await runner.createIndex(
      'discovery_account',
      new TableIndex({
        name: 'IDX_discovery_account_user_provider',
        columnNames: ['userId', 'provider'],
        isUnique: true,
      })
    );
    await runner.createForeignKey(
      'discovery_account',
      new TableForeignKey({
        columnNames: ['userId'],
        referencedTableName: 'user',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      })
    );
  }
  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('discovery_account');
  }
}

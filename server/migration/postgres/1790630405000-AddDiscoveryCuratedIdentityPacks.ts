import {
  Table,
  TableForeignKey,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddDiscoveryCuratedIdentityPacks1790630405000 implements MigrationInterface {
  name = 'AddDiscoveryCuratedIdentityPacks1790630405000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'discovery_curated_identity_pack',
        columns: [
          {
            name: 'packId',
            type: 'varchar',
            length: '64',
            isPrimary: true,
          },
          { name: 'name', type: 'varchar', length: '128' },
          { name: 'version', type: 'integer' },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      })
    );
    await runner.createTable(
      new Table({
        name: 'discovery_curated_identity_mapping',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'packId', type: 'varchar', length: '64' },
          { name: 'identity', type: 'varchar', length: '256' },
          { name: 'tmdbId', type: 'integer' },
          { name: 'mediaType', type: 'varchar' },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      })
    );
    await runner.createIndex(
      'discovery_curated_identity_mapping',
      new TableIndex({
        name: 'IDX_discovery_curated_identity_mapping_identity',
        columnNames: ['identity'],
        isUnique: true,
      })
    );
    await runner.createIndex(
      'discovery_curated_identity_mapping',
      new TableIndex({
        name: 'IDX_discovery_curated_identity_mapping_pack_identity',
        columnNames: ['packId', 'identity'],
      })
    );
    await runner.createForeignKey(
      'discovery_curated_identity_mapping',
      new TableForeignKey({
        columnNames: ['packId'],
        referencedTableName: 'discovery_curated_identity_pack',
        referencedColumnNames: ['packId'],
        onDelete: 'CASCADE',
      })
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('discovery_curated_identity_mapping');
    await runner.dropTable('discovery_curated_identity_pack');
  }
}

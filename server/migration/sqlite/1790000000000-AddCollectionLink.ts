import {
  Table,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddCollectionLink1790000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('collection_link'))) {
      await queryRunner.createTable(
        new Table({
          name: 'collection_link',
          columns: [
            { name: 'id', type: 'varchar', length: '64', isPrimary: true },
            { name: 'collectionId', type: 'integer' },
            { name: 'serverId', type: 'varchar', length: '128' },
            { name: 'libraryId', type: 'varchar', length: '128' },
            { name: 'title', type: 'varchar', length: '512' },
            {
              name: 'remoteId',
              type: 'varchar',
              length: '128',
              isNullable: true,
            },
            { name: 'enabled', type: 'boolean', default: false },
            {
              name: 'state',
              type: 'varchar',
              length: '24',
              default: "'pending'",
            },
          ],
        })
      );
    }
    const table = await queryRunner.getTable('collection_link');
    if (
      !table?.indices.some(
        (index) => index.name === 'IDX_collection_link_collection'
      )
    ) {
      await queryRunner.createIndex(
        'collection_link',
        new TableIndex({
          name: 'IDX_collection_link_collection',
          columnNames: ['collectionId'],
        })
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('collection_link')) {
      await queryRunner.dropTable('collection_link');
    }
  }
}

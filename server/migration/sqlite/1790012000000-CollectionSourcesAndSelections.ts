import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class CollectionSourcesAndSelections1790012000000 implements MigrationInterface {
  public async up(runner: QueryRunner): Promise<void> {
    const columns = [
      new TableColumn({
        name: 'sourceType',
        type: 'varchar',
        length: '16',
        default: "'movie'",
      }),
      new TableColumn({
        name: 'sourceId',
        type: 'varchar',
        length: '128',
        isNullable: true,
      }),
      new TableColumn({ name: 'seenIds', type: 'text', isNullable: true }),
    ];
    for (const column of columns) {
      if (!(await runner.hasColumn('collection_link', column.name))) {
        await runner.addColumn('collection_link', column);
      }
    }
  }
  public async down(runner: QueryRunner): Promise<void> {
    for (const column of ['seenIds', 'sourceId', 'sourceType']) {
      if (await runner.hasColumn('collection_link', column)) {
        await runner.dropColumn('collection_link', column);
      }
    }
  }
}

import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddProviderManagedBookSearch1790910000000 implements MigrationInterface {
  name = 'AddProviderManagedBookSearch1790910000000';

  async up(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('book_request_search');
    if (!table || table.findColumnByName('providerManagedSearch')) return;

    await runner.addColumn(
      'book_request_search',
      new TableColumn({
        name: 'providerManagedSearch',
        type: 'boolean',
        isNullable: false,
        default: false,
      })
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('book_request_search');
    if (!table?.findColumnByName('providerManagedSearch')) return;

    await runner.dropColumn('book_request_search', 'providerManagedSearch');
  }
}

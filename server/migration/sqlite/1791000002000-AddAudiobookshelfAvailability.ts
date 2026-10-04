import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddAudiobookshelfAvailability1791000002000 implements MigrationInterface {
  name = 'AddAudiobookshelfAvailability1791000002000';

  async up(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('media');
    if (!table) return;
    for (const column of [
      new TableColumn({
        name: 'audiobookLibraryServiceId',
        type: 'integer',
        isNullable: true,
      }),
      new TableColumn({
        name: 'audiobookLibraryItemId',
        type: 'varchar',
        isNullable: true,
      }),
    ]) {
      if (!table.findColumnByName(column.name)) {
        await runner.addColumn('media', column);
      }
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('media');
    if (!table) return;
    for (const name of [
      'audiobookLibraryItemId',
      'audiobookLibraryServiceId',
    ]) {
      const column = table.findColumnByName(name);
      if (column) await runner.dropColumn('media', column);
    }
  }
}

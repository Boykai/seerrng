import { isPgsql } from '@server/utils/dbType';
import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddPendingImportProgress1791000001000 implements MigrationInterface {
  name = 'AddPendingImportProgress1791000001000';

  async up(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('book_request_search');
    if (!table) return;

    const additions: TableColumn[] = [
      new TableColumn({
        name: 'pendingAttemptCount',
        type: 'integer',
        isNullable: true,
      }),
      new TableColumn({
        name: 'pendingMaxAttempts',
        type: 'integer',
        isNullable: true,
      }),
      new TableColumn({
        name: 'pendingNextAttemptAt',
        type: isPgsql ? 'timestamp with time zone' : 'datetime',
        isNullable: true,
      }),
    ];

    for (const column of additions) {
      if (!table.findColumnByName(column.name)) {
        await runner.addColumn('book_request_search', column);
      }
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('book_request_search');
    if (!table) return;

    for (const name of [
      'pendingNextAttemptAt',
      'pendingMaxAttempts',
      'pendingAttemptCount',
    ]) {
      if (table.findColumnByName(name)) {
        await runner.dropColumn('book_request_search', name);
      }
    }
  }
}

import {
  Table,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class AddDesktopAuthTickets1790900000000 implements MigrationInterface {
  name = 'AddDesktopAuthTickets1790900000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'desktop_auth_ticket',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'userId', type: 'integer' },
          { name: 'sessionId', type: 'varchar', length: '255' },
          { name: 'credentialVersion', type: 'varchar', length: '20' },
          { name: 'jellyfinUserId', type: 'varchar', length: '64' },
          { name: 'jellyfinAuthorityKey', type: 'varchar', length: '16' },
          { name: 'ticketDigest', type: 'varchar', length: '64' },
          { name: 'challengeDigest', type: 'varchar', length: '64' },
          { name: 'protocolVersion', type: 'integer' },
          { name: 'expiresAt', type: 'datetime' },
          {
            name: 'createdAt',
            type: 'datetime',
            default: 'CURRENT_TIMESTAMP',
          },
          { name: 'consumedAt', type: 'datetime', isNullable: true },
        ],
      })
    );
    await runner.createIndex(
      'desktop_auth_ticket',
      new TableIndex({
        name: 'IDX_desktop_auth_ticket_digest_unique',
        columnNames: ['ticketDigest'],
        isUnique: true,
      })
    );
    await runner.createIndex(
      'desktop_auth_ticket',
      new TableIndex({
        name: 'IDX_desktop_auth_ticket_user',
        columnNames: ['userId'],
      })
    );
    await runner.createIndex(
      'desktop_auth_ticket',
      new TableIndex({
        name: 'IDX_desktop_auth_ticket_expires_at',
        columnNames: ['expiresAt'],
      })
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('desktop_auth_ticket');
  }
}

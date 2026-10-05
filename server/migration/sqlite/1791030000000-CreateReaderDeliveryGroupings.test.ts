import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { CreateReaderDeliveryGroupings1791030000000 } from './1791030000000-CreateReaderDeliveryGroupings';

test('creates durable provider grouping mappings with unique media identity', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new CreateReaderDeliveryGroupings1791030000000();

  try {
    await migration.up(queryRunner);
    assert.equal(await queryRunner.hasTable('reader_delivery_grouping'), true);
    await queryRunner.query(`
      INSERT INTO "reader_delivery_grouping"
        ("provider", "targetType", "targetId", "targetName", "groupName")
      VALUES ('grimmory', 'book-series', 'series/42', 'Earthsea', 'SeerrNG · Series · Earthsea')
    `);
    const [grouping] = await queryRunner.query(
      'SELECT "status", "isPublic", "syncToKobo", "lastMatchCount", "countVerified" FROM "reader_delivery_grouping"'
    );
    assert.deepEqual(grouping, {
      status: 'pending',
      isPublic: 1,
      syncToKobo: 0,
      lastMatchCount: 0,
      countVerified: 0,
    });
    await assert.rejects(
      queryRunner.query(`
        INSERT INTO "reader_delivery_grouping"
          ("provider", "targetType", "targetId", "targetName", "groupName")
        VALUES ('grimmory', 'book-series', 'series/42', 'Earthsea', 'Duplicate')
      `)
    );
    await migration.down(queryRunner);
    assert.equal(await queryRunner.hasTable('reader_delivery_grouping'), false);
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

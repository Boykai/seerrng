import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DataSource } from 'typeorm';
import { AddQueueInterventions1790630401000 } from './1790630401000-AddQueueInterventions';
it('creates durable warning identities, action history defaults, and supports rollback', async () => {
  const db = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const runner = db.createQueryRunner();
  const migration = new AddQueueInterventions1790630401000();
  try {
    await migration.up(runner);
    const insert = `INSERT INTO queue_intervention (identity,authority,serviceType,serviceId,serviceName,queueId,title,warnings) VALUES ('identity','authority','radarr',1,'Service',2,'Release','[]')`;
    await runner.query(insert);
    await assert.rejects(() => runner.query(insert), /UNIQUE/);
    const [row] = await runner.query(
      'SELECT state, actions, createdAt FROM queue_intervention'
    );
    assert.equal(row.state, 'active');
    assert.equal(row.actions, '[]');
    assert.ok(row.createdAt);
    await migration.down(runner);
    assert.equal(await runner.hasTable('queue_intervention'), false);
  } finally {
    await runner.release();
    await db.destroy();
  }
});

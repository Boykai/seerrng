import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DataSource } from 'typeorm';
import { AddReleaseCalendarHistory1790812800000 } from './1790812800000-AddReleaseCalendarHistory';

it('creates unique calendar snapshots and supports rollback', async () => {
  const db = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const runner = db.createQueryRunner();
  const migration = new AddReleaseCalendarHistory1790812800000();
  try {
    await migration.up(runner);
    const insert = `INSERT INTO release_calendar_snapshot (eventId, startsAt, allDay, observedAt, history) VALUES ('radarr:1:1','2026-09-12T00:00:00.000Z',1,'2026-09-01T04:00:00.000Z','[]')`;
    await runner.query(insert);
    await assert.rejects(() => runner.query(insert), /UNIQUE/);
    const [row] = await runner.query(
      'SELECT eventId, startsAt, allDay, history FROM release_calendar_snapshot'
    );
    assert.equal(row.eventId, 'radarr:1:1');
    assert.equal(row.allDay, 1);
    assert.equal(row.history, '[]');
    await migration.down(runner);
    assert.equal(await runner.hasTable('release_calendar_snapshot'), false);
  } finally {
    await runner.release();
    await db.destroy();
  }
});

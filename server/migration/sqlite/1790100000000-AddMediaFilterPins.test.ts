import { DataSource } from 'typeorm';
import { expect, it } from 'vitest';
import { AddMediaFilterPins1790100000000 } from './1790100000000-AddMediaFilterPins';

it('adds and removes media pins without changing existing settings', async () => {
  const db = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const runner = db.createQueryRunner();
  try {
    await runner.query(
      'CREATE TABLE user_settings (id integer PRIMARY KEY, locale text)'
    );
    await runner.query("INSERT INTO user_settings VALUES (1, 'en')");
    const migration = new AddMediaFilterPins1790100000000();
    await migration.up(runner);
    expect(await runner.query('SELECT * FROM user_settings')).toEqual([
      { id: 1, locale: 'en', mediaFilterPins: null },
    ]);
    await migration.down(runner);
    expect(await runner.query('SELECT * FROM user_settings')).toEqual([
      { id: 1, locale: 'en' },
    ]);
  } finally {
    await runner.release();
    await db.destroy();
  }
});

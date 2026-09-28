import assert from 'node:assert/strict';
import { it } from 'node:test';

import dataSource from '@server/datasource';
import { setupTestDb } from '@server/test/db';
import migrationArrTags from './0007_migrate_arr_tags';

setupTestDb();

it('does not require user settings columns added by later database migrations', async () => {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    await queryRunner.query(
      'ALTER TABLE "user_settings" DROP COLUMN "mediaFilterPins"'
    );
  } finally {
    await queryRunner.release();
  }

  const migrated = await migrationArrTags({
    migrations: [],
    radarr: [],
    sonarr: [],
  });

  assert.deepStrictEqual(migrated.migrations, ['0007_migrate_arr_tags']);
});

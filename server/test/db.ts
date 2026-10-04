import { getSettings } from '@server/lib/settings';
import { resetTestDb, seedTestDb } from '@server/utils/seedTestDb';
import { before, beforeEach } from 'node:test';

export function setupTestDb() {
  before(async () => {
    // API tests exercise metadata and response handling, not the background
    // poster warmer. Dedicated warmer tests enable this setting explicitly.
    getSettings().main.cacheImages = false;
    await seedTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
  });
}

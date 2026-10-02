import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  SuwayomiInstanceChangedError,
  runWithSuwayomiInstanceAdmission,
  snapshotSuwayomiInstance,
} from '@server/lib/suwayomi/instanceAdmission';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

const instance = (
  overrides: Partial<SuwayomiSettings> = {}
): SuwayomiSettings => ({
  id: 3,
  name: 'Suwayomi',
  hostname: 'suwayomi.invalid',
  port: 4567,
  useSsl: false,
  baseUrl: '',
  isDefault: true,
  authMode: 'BASIC_AUTH',
  username: 'fake-user',
  password: randomUUID(),
  sourceAllowlist: [],
  preferredLanguages: [],
  scanlatorPreference: [],
  requireCbz: true,
  ...overrides,
});

beforeEach(() => {
  getSettings().suwayomi = [];
});

afterEach(() => {
  getSettings().suwayomi = [];
});

describe('Suwayomi instance admission', () => {
  it('copies the settings, so later edits do not reach the snapshot', () => {
    const stored = instance({ sourceAllowlist: ['0'] });
    getSettings().suwayomi = [stored];

    const snapshot = snapshotSuwayomiInstance(3);
    stored.sourceAllowlist.push('1');

    assert.ok(snapshot);
    assert.notEqual(snapshot, stored);
    assert.deepEqual(snapshot.sourceAllowlist, ['0']);
    assert.equal(snapshotSuwayomiInstance(4), undefined);
  });

  it('runs the write while the address and login still match', async () => {
    getSettings().suwayomi = [instance()];
    const snapshot = snapshotSuwayomiInstance(3);
    assert.ok(snapshot);
    getSettings().suwayomi = [
      { ...snapshot, name: 'Renamed', sourceAllowlist: ['0'] },
    ];

    assert.equal(
      await runWithSuwayomiInstanceAdmission(snapshot, async () => 'written'),
      'written'
    );
  });

  it('refuses the write after a login change or a removal', async () => {
    getSettings().suwayomi = [instance()];
    const snapshot = snapshotSuwayomiInstance(3);
    assert.ok(snapshot);
    let writes = 0;
    const write = async () => {
      writes += 1;
    };

    getSettings().suwayomi = [instance({ password: randomUUID() })];
    await assert.rejects(
      runWithSuwayomiInstanceAdmission(snapshot, write),
      SuwayomiInstanceChangedError
    );
    getSettings().suwayomi = [{ ...snapshot, port: 4568 }];
    await assert.rejects(
      runWithSuwayomiInstanceAdmission(snapshot, write),
      SuwayomiInstanceChangedError
    );
    getSettings().suwayomi = [];
    await assert.rejects(
      runWithSuwayomiInstanceAdmission(snapshot, write),
      SuwayomiInstanceChangedError
    );
    assert.equal(writes, 0);
  });
});

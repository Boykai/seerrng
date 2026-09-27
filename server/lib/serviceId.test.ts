import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import OverrideRule from '@server/entity/OverrideRule';
import { setupTestDb } from '@server/test/db';
import {
  allocateServarrServiceId,
  getHistoricalServarrServiceIdMaximum,
  MAX_SERVARR_SERVICE_ID,
} from './serviceId';

setupTestDb();

describe('Servarr service ID allocation', () => {
  it('does not reuse deleted IDs retained by persisted references', async () => {
    await getRepository(OverrideRule).save([
      new OverrideRule({ radarrServiceId: 4 }),
      new OverrideRule({ sonarrServiceId: 5 }),
      new OverrideRule({ lidarrServiceId: 6 }),
    ]);
    await getRepository(Media).save([
      new Media({
        mediaType: MediaType.BOOK,
        tmdbId: 999_999_991,
        serviceId: 7,
      }),
      new Media({
        mediaType: MediaType.COMIC,
        tmdbId: 999_999_992,
        serviceId: 8,
      }),
    ]);

    assert.strictEqual(await getHistoricalServarrServiceIdMaximum('radarr'), 4);
    assert.strictEqual(await getHistoricalServarrServiceIdMaximum('sonarr'), 5);
    assert.strictEqual(await getHistoricalServarrServiceIdMaximum('lidarr'), 6);
    assert.strictEqual(
      await getHistoricalServarrServiceIdMaximum('readarr'),
      7
    );
    assert.strictEqual(await getHistoricalServarrServiceIdMaximum('mylar'), 8);
    assert.strictEqual(
      await getHistoricalServarrServiceIdMaximum('kapowarr'),
      8
    );
    assert.strictEqual(allocateServarrServiceId([], -1), 0);
    assert.strictEqual(allocateServarrServiceId([], 7), 8);
    assert.strictEqual(allocateServarrServiceId([9], 7), 10);
  });

  it('rejects malformed and exhausted ID ranges', () => {
    assert.throws(
      () => allocateServarrServiceId([Number.NaN], 1),
      /supported range/i
    );
    assert.throws(
      () => allocateServarrServiceId([], MAX_SERVARR_SERVICE_ID),
      /no service IDs remain/i
    );
  });
});

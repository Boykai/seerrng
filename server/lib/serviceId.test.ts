import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import { setupTestDb } from '@server/test/db';
import {
  allocateServarrServiceId,
  assertServarrServiceCanBeRemoved,
  getHistoricalServarrServiceIdMaximum,
  MAX_SERVARR_SERVICE_ID,
  ServarrServiceInUseError,
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

  it('gives Suwayomi the manga ID space', async () => {
    await getRepository(Media).save([
      new Media({
        mediaType: MediaType.MANGA,
        tmdbId: 0,
        serviceId: 3,
      }),
      new Media({
        mediaType: MediaType.COMIC,
        tmdbId: 999_999_993,
        serviceId: 9,
      }),
    ]);

    assert.strictEqual(
      await getHistoricalServarrServiceIdMaximum('suwayomi'),
      3
    );
  });

  it('keeps a Suwayomi instance while a manga request uses it', async () => {
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MANGA,
        tmdbId: 0,
        status: MediaStatus.PENDING,
      })
    );
    const active = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MANGA,
        media,
        requestedBy: user,
        status: MediaRequestStatus.PENDING,
        serverId: 2,
        is4k: false,
      })
    );

    await assert.rejects(
      assertServarrServiceCanBeRemoved('suwayomi', 2),
      ServarrServiceInUseError
    );
    await assertServarrServiceCanBeRemoved('suwayomi', 1);
    await assertServarrServiceCanBeRemoved('kapowarr', 2);

    await getRepository(MediaRequest).update(active.id, {
      status: MediaRequestStatus.COMPLETED,
    });
    await assertServarrServiceCanBeRemoved('suwayomi', 2);
  });
});

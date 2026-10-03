import { MediaStatus } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaSourceBinding, {
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import {
  createMangaMedia,
  newMangaMediaTally,
  reconcileMangaMedia,
} from '@server/lib/mangaMedia';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const { AVAILABLE, PARTIALLY_AVAILABLE, PENDING, UNKNOWN } = MediaStatus;
const EARLIER = new Date('2020-01-02T03:04:05.000Z');

/** Manga media at `status`, with `mediaAddedAt` set to `addedAt`. */
const seedMedia = async (
  anilistId: number,
  status: MediaStatus,
  addedAt: Date | null
) => {
  const media = await createMangaMedia(dataSource.manager, anilistId, status);
  await getRepository(Media).update(media.id, {
    mediaAddedAt: addedAt as Date,
  });
  return media.id;
};

/** One in-library binding that asks for `availability`. */
const seedBinding = (anilistId: number, availability: MediaStatus) =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId: 1,
      sourceId: '1000',
      url: `/sample/${anilistId}`,
      urlHash: hashMangaSourceUrl(`/sample/${anilistId}`),
      anilistId,
      suwayomiMangaId: anilistId,
      title: `Sample Manga ${anilistId}`,
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state: MangaBindingState.ACTIVE,
      inLibrary: true,
      availability,
      chapterCount: 2,
      downloadCount: availability === UNKNOWN ? 0 : 2,
    })
  );

const reconcile = async (anilistId: number, mediaId: number) => {
  await reconcileMangaMedia([anilistId], {
    completedInstanceIds: new Set([1]),
    tally: newMangaMediaTally(),
    admitted: true,
  });
  return getRepository(Media).findOneByOrFail({ id: mediaId });
};

describe('manga media added date', () => {
  it('dates a title when it first becomes available', async () => {
    for (const [anilistId, status, target] of [
      [1, PENDING, AVAILABLE],
      [2, UNKNOWN, PARTIALLY_AVAILABLE],
    ] as const) {
      const id = await seedMedia(anilistId, status, null);
      await seedBinding(anilistId, target);
      const before = Date.now();

      const media = await reconcile(anilistId, id);

      assert.equal(media.status, target);
      assert.ok(media.mediaAddedAt instanceof Date);
      assert.ok(media.mediaAddedAt.getTime() >= before - 1_000);
    }
  });

  it('dates an available title that has no date yet', async () => {
    const id = await seedMedia(3, PARTIALLY_AVAILABLE, null);
    await seedBinding(3, AVAILABLE);

    const media = await reconcile(3, id);

    assert.equal(media.status, AVAILABLE);
    assert.ok(media.mediaAddedAt instanceof Date);
  });

  it('keeps the date on a move from partial to available', async () => {
    const id = await seedMedia(4, PARTIALLY_AVAILABLE, EARLIER);
    await seedBinding(4, AVAILABLE);

    const media = await reconcile(4, id);

    assert.equal(media.status, AVAILABLE);
    assert.equal(media.mediaAddedAt.getTime(), EARLIER.getTime());
  });

  it('keeps the date on a downgrade and dates the next raise', async () => {
    const id = await seedMedia(5, AVAILABLE, EARLIER);
    const binding = await seedBinding(5, UNKNOWN);

    const lowered = await reconcile(5, id);
    assert.equal(lowered.status, UNKNOWN);
    assert.equal(lowered.mediaAddedAt.getTime(), EARLIER.getTime());

    await getRepository(MangaSourceBinding).update(binding.id, {
      availability: AVAILABLE,
    });
    const raised = await reconcile(5, id);
    assert.equal(raised.status, AVAILABLE);
    assert.ok(raised.mediaAddedAt.getTime() > EARLIER.getTime());
  });
});

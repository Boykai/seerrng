import {
  MangaAttentionCode,
  MangaDispatchError,
  MangaRequestCheckpoint,
} from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import notificationManager from '@server/lib/notifications';
import requestDispatchManager from '@server/lib/requestDispatch';
import {
  RequestStatusStage,
  getRequestStatusPage,
} from '@server/lib/requestStatus';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  fakeDispatchChapters,
  fakeDispatchManga,
  seedDispatchRequest,
} from '@server/test/fakeSuwayomiDispatch';
import { seedProgressRequest } from '@server/test/fakeSuwayomiProgress';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

const settings = getSettings();
const categories = settings.main.enabledMediaCategories;

/** An approved movie its service tracks with nothing downloading: SEARCHING. */
const seedSearchingMovie = async (tmdbId: number): Promise<number> => {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      serviceId: 0,
      externalServiceId: 20,
    })
  );
  const { id } = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      isAutoRequest: false,
    })
  );
  await dataSource
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status: MediaRequestStatus.APPROVED })
    .where({ id })
    .callListeners(false)
    .execute();
  return id;
};

/** A manga request whose dispatch queued chapters 1 and 2. */
const seedEnqueuedManga = async (
  anilistId: number,
  attentionCode: MangaAttentionCode | null
): Promise<number> => {
  const { request } = await seedProgressRequest(
    fakeDispatchManga(anilistId, {
      inLibrary: true,
      chapters: fakeDispatchChapters(anilistId, [1, 2]),
    }),
    {
      anilistId,
      mediaStatus: MediaStatus.PROCESSING,
      manifest: { attentionCode, chaptersTotal: 2, chaptersQueued: 2 },
    }
  );
  return request.id;
};

const pageOf = (filter?: string) =>
  getRequestStatusPage({ take: 10, skip: 0, filter });

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

const idsOf = ({ results }: Awaited<ReturnType<typeof pageOf>>) =>
  sorted(results.map(({ request }) => request.id));

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  mock.method(requestDispatchManager, 'enqueue', async () => undefined);
  mock.method(notificationManager, 'sendNotificationIntent', async () => {
    return;
  });
});

afterEach(async () => {
  try {
    await waitForBackgroundTasks();
  } finally {
    mock.restoreAll();
    settings.main.enabledMediaCategories = categories;
  }
});

describe('request status: manga that needs attention', () => {
  it('lists and counts a flagged manga request as needing attention, not in progress', async () => {
    const flagged = await seedEnqueuedManga(
      9101,
      MangaAttentionCode.BINDING_ORPHANED
    );
    const downloading = await seedEnqueuedManga(9102, null);
    // Dispatch recorded the chapters, then lost the match before queueing.
    const { request: stopped } = await seedDispatchRequest({
      anilistId: 9103,
      manifest: {
        checkpoint: MangaRequestCheckpoint.MANIFEST_FROZEN,
        checkpointAt: new Date(),
        frozenAt: new Date(),
        lastError: MangaDispatchError.BINDING_MISSING,
      },
    });
    const movie = await seedSearchingMovie(91201);

    const all = await pageOf();
    const stages = new Map(
      all.results.map(({ request, status }) => [
        request.id,
        [status.stage, status.needsAttention],
      ])
    );
    assert.deepStrictEqual(
      Object.fromEntries(stages),
      Object.fromEntries([
        [flagged, [RequestStatusStage.DOWNLOADING, true]],
        [downloading, [RequestStatusStage.DOWNLOADING, false]],
        [stopped.id, [RequestStatusStage.SEARCHING, true]],
        [movie, [RequestStatusStage.SEARCHING, false]],
      ])
    );

    const attention = await pageOf('attention');
    const active = await pageOf('active');
    const processing = await pageOf('processing');
    assert.deepStrictEqual(idsOf(attention), sorted([flagged, stopped.id]));
    assert.deepStrictEqual(idsOf(active), sorted([downloading, movie]));
    assert.deepStrictEqual(idsOf(processing), sorted([downloading, movie]));
    for (const page of [all, attention, active, processing]) {
      const {
        total,
        active: activeCount,
        attention: attentionCount,
      } = page.counts;
      assert.deepStrictEqual(
        { total, active: activeCount, attention: attentionCount },
        {
          total: 4,
          active: active.results.length,
          attention: attention.results.length,
        }
      );
    }
  });
});

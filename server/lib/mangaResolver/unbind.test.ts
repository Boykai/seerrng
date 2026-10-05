import {
  MangaAttentionCode,
  MangaRequestBindingState,
} from '@server/constants/mangaRequest';
import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import { MangaResolutionStatus } from '@server/entity/MangaSourceResolution';
import downloadTracker from '@server/lib/downloadtracker';
import { pollMangaProgress } from '@server/lib/mangaProgress';
import { unbindMangaResolveTitle } from '@server/lib/mangaResolver/review';
import notificationManager from '@server/lib/notifications';
import requestDispatchManager from '@server/lib/requestDispatch';
import {
  RequestStatusStage,
  getRequestStatusPage,
} from '@server/lib/requestStatus';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { setupTestDb } from '@server/test/db';
import {
  dispatchClientFor,
  dispatchInstanceFor,
  fakeDispatchChapters,
  fakeDispatchManga,
  seedDispatchBinding,
  seedDispatchRequest,
} from '@server/test/fakeSuwayomiDispatch';
import {
  assertProgressTraffic,
  seedProgressRequest,
  startFakeProgressSuwayomi,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const fakes: FakeProgressSuwayomi[] = [];
let queued: number[] = [];

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

const manifestOf = (requestId: number) =>
  getRepository(MangaRequestManifest).findOneByOrFail({ requestId });

const idsOf = (page: Awaited<ReturnType<typeof getRequestStatusPage>>) =>
  page.results.map(({ request }) => request.id);

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  configure();
  queued = [];
  mock.method(requestDispatchManager, 'enqueue', async (requestId: number) => {
    queued.push(requestId);
  });
  mock.method(notificationManager, 'sendNotificationIntent', async () => {
    return;
  });
  downloadTracker.pruneMangaProgress(new Map());
});

afterEach(async () => {
  try {
    await waitForBackgroundTasks();
    for (const fake of fakes) {
      assertProgressTraffic(fake.server);
    }
  } finally {
    mock.restoreAll();
    settings.main.enabledMediaCategories = categories;
    configure();
    downloadTracker.pruneMangaProgress(new Map());
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

describe('unbindMangaResolveTitle', () => {
  it('parks the requests not sent yet and flags the sent one, without Suwayomi', async () => {
    const manga = fakeDispatchManga(11, {
      inLibrary: true,
      chapters: fakeDispatchChapters(11, [1, 2]),
    });
    const fake = await startFakeProgressSuwayomi([manga]);
    fakes.push(fake);
    configure(dispatchInstanceFor(fake.server));
    const binding = await seedDispatchBinding(manga);
    // Dispatch recorded this request's chapters and queued them.
    const sent = await seedProgressRequest(manga, {
      mediaStatus: MediaStatus.PROCESSING,
    });
    fake.state.queue.push(...manga.chapters.map(({ id }) => id));
    // Dispatch has not recorded this one's chapters yet.
    const waiting = await seedDispatchRequest({ media: sent.media });
    const sentBefore = await manifestOf(sent.request.id);

    const { title } = await unbindMangaResolveTitle(9001, {
      instanceId: 1,
      bindingId: binding.id,
    });

    assert.deepStrictEqual(fake.server.requests, []);
    assert.deepStrictEqual(queued, []);
    assert.strictEqual(title.status, MangaResolutionStatus.QUEUED);
    assert.strictEqual(
      (
        await getRepository(MangaSourceBinding).findOneByOrFail({
          id: binding.id,
        })
      ).state,
      MangaBindingState.REJECTED
    );
    assert.strictEqual(
      (await manifestOf(waiting.request.id)).bindingState,
      MangaRequestBindingState.AWAITING_BINDING
    );
    const kept = await manifestOf(sent.request.id);
    assert.strictEqual(kept.bindingState, MangaRequestBindingState.BOUND);
    assert.strictEqual(kept.bindingSourceId, manga.sourceId);
    assert.strictEqual(kept.bindingUrlHash, hashMangaSourceUrl(manga.url));
    assert.strictEqual(kept.suwayomiMangaId, manga.id);
    assert.deepStrictEqual(kept.frozenAt, sentBefore.frozenAt);
    assert.strictEqual(kept.attentionCode, null);

    await pollMangaProgress({
      clientFor: (id) =>
        id === 1 ? dispatchClientFor(fake.server) : undefined,
    });

    const flagged = await manifestOf(sent.request.id);
    assert.strictEqual(
      flagged.attentionCode,
      MangaAttentionCode.BINDING_ORPHANED
    );
    assert.strictEqual(flagged.bindingState, MangaRequestBindingState.BOUND);
    assert.deepStrictEqual(
      fake.state.queue,
      manga.chapters.map(({ id }) => id)
    );

    const reads = fake.server.requests.length;
    const attention = await getRequestStatusPage({
      take: 10,
      skip: 0,
      filter: 'attention',
    });
    const processing = await getRequestStatusPage({
      take: 10,
      skip: 0,
      filter: 'processing',
    });
    const active = await getRequestStatusPage({
      take: 10,
      skip: 0,
      filter: 'active',
    });
    assert.strictEqual(fake.server.requests.length, reads);
    assert.deepStrictEqual(idsOf(attention), [sent.request.id]);
    assert.strictEqual(
      attention.results[0].status.stage,
      RequestStatusStage.DOWNLOADING
    );
    assert.strictEqual(attention.results[0].status.needsAttention, true);
    assert.deepStrictEqual(idsOf(processing), []);
    assert.deepStrictEqual(idsOf(active), [waiting.request.id]);
    assert.strictEqual(
      active.results[0].status.stage,
      RequestStatusStage.APPROVED
    );
    assert.strictEqual(active.results[0].status.needsAttention, false);
    const {
      total,
      active: activeCount,
      attention: attentionCount,
    } = active.counts;
    assert.deepStrictEqual(
      { total, active: activeCount, attention: attentionCount },
      { total: 2, active: 1, attention: 1 }
    );
  });
});

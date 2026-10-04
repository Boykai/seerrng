import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { User } from '@server/entity/User';
import {
  enqueueMangaRequestDispatch,
  hasActiveMangaBinding,
  syncMangaRequestBindings,
} from '@server/lib/mangaRequestBindings';
import { DEFAULT_MANGA_REQUEST_SCOPE } from '@server/lib/mangaRequests';
import requestDispatchManager from '@server/lib/requestDispatch';
import logger from '@server/logger';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import { SelectQueryBuilder } from 'typeorm';

setupTestDb();

afterEach(async () => {
  await waitForBackgroundTasks();
  mock.restoreAll();
});

const { AWAITING_BINDING, BOUND } = MangaRequestBindingState;

const seedManifest = async (
  anilistId: number,
  instanceId: number,
  overrides: Partial<MangaRequestManifest> = {}
): Promise<MangaRequestManifest> => {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: 0,
      mediaType: MediaType.MANGA,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MANGA,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      serverId: instanceId,
    })
  );
  return getRepository(MangaRequestManifest).save(
    new MangaRequestManifest({
      requestId: request.id,
      anilistId,
      instanceId,
      ...DEFAULT_MANGA_REQUEST_SCOPE,
      ...overrides,
    })
  );
};

const seedBinding = (
  anilistId: number,
  instanceId: number,
  state = MangaBindingState.ACTIVE,
  url = `/manga/${anilistId}`
) =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId,
      sourceId: '1000',
      url,
      urlHash: hashMangaSourceUrl(url),
      anilistId,
      suwayomiMangaId: 1,
      title: 'Sample Manga',
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state,
      inLibrary: state === MangaBindingState.ACTIVE,
    })
  );

/** Approves the request without listeners, so nothing is queued. */
const approve = (requestId: number) =>
  dataSource
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status: MediaRequestStatus.APPROVED })
    .where({ id: requestId })
    .callListeners(false)
    .execute();

const seedApprovedManifest = async (anilistId: number) => {
  const manifest = await seedManifest(anilistId, 1);
  await approve(manifest.requestId);
  return manifest;
};

/** An approved movie request, which manga dispatch must never queue. */
const seedApprovedMovieRequest = async (): Promise<number> => {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: 990001,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const { id } = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
    })
  );
  await approve(id);
  return id;
};

/** Records each dispatch the outbox starts; none reaches a service. */
const recordDispatches = () => {
  const dispatched: number[] = [];
  mock.method(
    MediaRequestSubscriber.prototype,
    'dispatchRequestById',
    async (requestId: number) => {
      dispatched.push(requestId);
      return { delivered: true };
    }
  );
  return dispatched;
};

const outboxRequestIds = async () =>
  (
    await getRepository(RequestDispatchOutbox).find({ order: { id: 'ASC' } })
  ).map(({ requestId }) => requestId);

const stateOf = async (manifest: MangaRequestManifest) => {
  const { bindingState, boundAt } = await getRepository(
    MangaRequestManifest
  ).findOneByOrFail({ id: manifest.id });
  return { bindingState, bound: boundAt instanceof Date };
};

describe('hasActiveMangaBinding', () => {
  it('counts only an ACTIVE binding of the title on the instance', async () => {
    await seedBinding(900001, 1);
    await seedBinding(900002, 1, MangaBindingState.ORPHANED);
    await seedBinding(900003, 1, MangaBindingState.REJECTED);

    assert.strictEqual(
      await hasActiveMangaBinding(dataSource.manager, 900001, 1),
      true
    );
    assert.strictEqual(
      await hasActiveMangaBinding(dataSource.manager, 900001, 2),
      false
    );
    assert.strictEqual(
      await hasActiveMangaBinding(dataSource.manager, 900002, 1),
      false
    );
    assert.strictEqual(
      await hasActiveMangaBinding(dataSource.manager, 900003, 1),
      false
    );
  });
});

describe('syncMangaRequestBindings', () => {
  it('releases a parked request once its binding appears, and parks it again when it goes', async () => {
    const parked = await seedManifest(900001, 1);
    assert.deepStrictEqual(await stateOf(parked), {
      bindingState: AWAITING_BINDING,
      bound: false,
    });

    // A binding on another instance doesn't release it.
    const elsewhere = await seedBinding(900001, 2, MangaBindingState.ACTIVE);
    await syncMangaRequestBindings(dataSource.manager);
    assert.deepStrictEqual(await stateOf(parked), {
      bindingState: AWAITING_BINDING,
      bound: false,
    });

    const binding = await seedBinding(
      900001,
      1,
      MangaBindingState.ACTIVE,
      '/b'
    );
    await syncMangaRequestBindings(dataSource.manager, [900001]);
    assert.deepStrictEqual(await stateOf(parked), {
      bindingState: BOUND,
      bound: true,
    });

    await getRepository(MangaSourceBinding).update(binding.id, {
      state: MangaBindingState.ORPHANED,
      inLibrary: false,
    });
    await syncMangaRequestBindings(dataSource.manager, [900001]);
    assert.deepStrictEqual(await stateOf(parked), {
      bindingState: AWAITING_BINDING,
      bound: false,
    });
    assert.ok(elsewhere.id);
  });

  it('touches only the listed titles', async () => {
    const listed = await seedManifest(900001, 1);
    const unlisted = await seedManifest(900002, 1);
    await seedBinding(900001, 1);
    await seedBinding(900002, 1, MangaBindingState.ACTIVE, '/other');

    await syncMangaRequestBindings(dataSource.manager, [900001, 900001]);

    assert.strictEqual((await stateOf(listed)).bindingState, BOUND);
    assert.strictEqual(
      (await stateOf(unlisted)).bindingState,
      AWAITING_BINDING
    );

    await syncMangaRequestBindings(dataSource.manager, []);
    assert.strictEqual(
      (await stateOf(unlisted)).bindingState,
      AWAITING_BINDING
    );

    await syncMangaRequestBindings(dataSource.manager);
    assert.strictEqual((await stateOf(unlisted)).bindingState, BOUND);
  });

  it('leaves frozen manifests to the dispatcher', async () => {
    const frozenParked = await seedManifest(900001, 1, {
      frozenAt: new Date(),
    });
    const frozenBound = await seedManifest(900002, 1, {
      frozenAt: new Date(),
      bindingState: BOUND,
      boundAt: new Date(),
    });
    await seedBinding(900001, 1);

    await syncMangaRequestBindings(dataSource.manager);

    assert.deepStrictEqual(await stateOf(frozenParked), {
      bindingState: AWAITING_BINDING,
      bound: false,
    });
    assert.deepStrictEqual(await stateOf(frozenBound), {
      bindingState: BOUND,
      bound: true,
    });
  });

  it('syncs more titles than one statement carries', async () => {
    const manifest = await seedManifest(900001, 1);
    await seedBinding(900001, 1);
    const ids = [
      ...Array.from({ length: 600 }, (_, index) => 800_000 + index),
      900001,
    ];

    await syncMangaRequestBindings(dataSource.manager, ids);

    assert.strictEqual((await stateOf(manifest)).bindingState, BOUND);
  });

  it('runs on the caller transaction and never enqueues dispatch', async () => {
    const manifest = await seedManifest(900001, 1);

    await assert.rejects(
      dataSource.transaction(async (manager) => {
        await manager.save(
          new MangaSourceBinding({
            instanceId: 1,
            sourceId: '1000',
            url: '/manga/tx',
            urlHash: hashMangaSourceUrl('/manga/tx'),
            anilistId: 900001,
            suwayomiMangaId: 1,
            title: 'Sample Manga',
            confidence: MangaBindingConfidence.MANUAL,
            matchedBy: 'manual',
            origin: 'admin',
            state: MangaBindingState.ACTIVE,
            inLibrary: true,
          })
        );
        await syncMangaRequestBindings(manager, [900001]);
        assert.strictEqual(
          (
            await manager.findOneByOrFail(MangaRequestManifest, {
              id: manifest.id,
            })
          ).bindingState,
          BOUND
        );
        throw new Error('force rollback');
      }),
      /force rollback/
    );

    assert.strictEqual(
      (await stateOf(manifest)).bindingState,
      AWAITING_BINDING
    );
    assert.strictEqual(
      (
        await getRepository(MediaRequest).findOneByOrFail({
          id: manifest.requestId,
        })
      ).status,
      MediaRequestStatus.PENDING
    );
  });
});

describe('syncMangaRequestBindings: moved requests', () => {
  it('returns the requests it moved to BOUND, and only those', async () => {
    const parked = await seedManifest(900001, 1);
    await seedManifest(900002, 1);
    await seedManifest(900003, 1, { bindingState: BOUND, boundAt: new Date() });
    await seedManifest(900004, 1, { frozenAt: new Date() });
    for (const anilistId of [900001, 900003, 900004]) {
      await seedBinding(anilistId, 1);
    }

    assert.deepStrictEqual(await syncMangaRequestBindings(dataSource.manager), [
      parked.requestId,
    ]);
    assert.deepStrictEqual(
      await syncMangaRequestBindings(dataSource.manager),
      []
    );

    const sliced = await seedManifest(900005, 1);
    await seedBinding(900005, 1);
    assert.deepStrictEqual(
      await syncMangaRequestBindings(dataSource.manager, [
        ...Array.from({ length: 600 }, (_, index) => 800_000 + index),
        900005,
        900001,
      ]),
      [sliced.requestId]
    );
  });
});

describe('syncMangaRequestBindings: a request that changes mid-sync', () => {
  it('leaves out a request frozen between the read and the write', async () => {
    const raced = await seedManifest(900001, 1);
    const moved = await seedManifest(900002, 1);
    await seedBinding(900001, 1);
    await seedBinding(900002, 1);
    const getRawMany = SelectQueryBuilder.prototype.getRawMany;
    let raceRan = false;
    mock.method(
      SelectQueryBuilder.prototype,
      'getRawMany',
      async function (this: SelectQueryBuilder<object>) {
        const rows = await getRawMany.call(this);
        if (
          !raceRan &&
          this.expressionMap.mainAlias?.name === 'manga_request_manifest'
        ) {
          raceRan = true;
          await getRepository(MangaRequestManifest).update(
            { id: raced.id },
            { frozenAt: new Date() }
          );
        }
        return rows;
      }
    );

    assert.deepStrictEqual(await syncMangaRequestBindings(dataSource.manager), [
      moved.requestId,
    ]);
    assert.equal(raceRan, true);
    assert.equal(
      (await stateOf(raced)).bindingState,
      MangaRequestBindingState.AWAITING_BINDING
    );
  });
});

describe('enqueueMangaRequestDispatch', () => {
  it('queues approved manga requests with the caller transaction and dispatches them after it commits', async () => {
    const approved = await seedApprovedManifest(900001);
    const pending = await seedManifest(900002, 1);
    const movie = await seedApprovedMovieRequest();
    const dispatched = recordDispatches();

    await dataSource.transaction(async (manager) => {
      await enqueueMangaRequestDispatch(
        [approved.requestId, pending.requestId, movie, approved.requestId],
        manager
      );
      assert.deepStrictEqual(
        (await manager.find(RequestDispatchOutbox)).map(
          ({ requestId }) => requestId
        ),
        [approved.requestId]
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(dispatched, []);
    });
    await waitForBackgroundTasks();

    assert.deepStrictEqual(dispatched, [approved.requestId]);
    assert.deepStrictEqual(await outboxRequestIds(), []);
  });

  it('queues and dispatches at once without a transaction', async () => {
    const first = await seedApprovedManifest(900001);
    const second = await seedApprovedManifest(900002);
    const dispatched = recordDispatches();

    await enqueueMangaRequestDispatch([second.requestId, first.requestId]);
    await enqueueMangaRequestDispatch([], dataSource.manager);
    await waitForBackgroundTasks();

    assert.deepStrictEqual(
      [...dispatched].sort((a, b) => a - b),
      [first.requestId, second.requestId]
    );
    assert.deepStrictEqual(await outboxRequestIds(), []);
  });

  it('drops the queued dispatch when the caller transaction rolls back', async () => {
    const approved = await seedApprovedManifest(900001);
    const dispatched = recordDispatches();

    await assert.rejects(
      dataSource.transaction(async (manager) => {
        await enqueueMangaRequestDispatch([approved.requestId], manager);
        throw new Error('force rollback');
      }),
      /force rollback/
    );
    await waitForBackgroundTasks();

    assert.deepStrictEqual(dispatched, []);
    assert.deepStrictEqual(await outboxRequestIds(), []);
  });

  it('only logs a failure outside a transaction: the sweep finds the requests', async () => {
    const first = await seedApprovedManifest(900001);
    const second = await seedApprovedManifest(900002);
    const warnings: unknown[][] = [];
    mock.method(logger, 'warn', (...args: unknown[]) => {
      warnings.push(args);
      return logger;
    });
    mock.method(requestDispatchManager, 'enqueue', async () => {
      throw new TypeError('synthetic');
    });

    await enqueueMangaRequestDispatch([first.requestId, second.requestId]);
    await enqueueMangaRequestDispatch([first.requestId], dataSource.manager);

    assert.deepStrictEqual(warnings, [
      [
        'Manga requests could not be queued for dispatch',
        { label: 'Manga Requests', count: 2, errorName: 'TypeError' },
      ],
      [
        'Manga requests could not be queued for dispatch',
        { label: 'Manga Requests', count: 1, errorName: 'TypeError' },
      ],
    ]);
  });

  it('fails the caller transaction when queuing inside it fails', async () => {
    const approved = await seedApprovedManifest(900001);
    mock.method(requestDispatchManager, 'enqueue', async () => {
      throw new TypeError('synthetic');
    });

    await assert.rejects(
      dataSource.transaction((manager) =>
        enqueueMangaRequestDispatch([approved.requestId], manager)
      ),
      TypeError
    );
  });
});

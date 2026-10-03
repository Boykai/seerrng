import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeEach, describe, it, mock } from 'node:test';
import {
  REQUEST_DISPATCH_CONCURRENCY,
  RequestDispatchManager,
  getRequestDispatchRetryDelayMs,
} from '.';

setupTestDb();

const createPendingRequest = async (tmdbId = 12345): Promise<MediaRequest> => {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      isAutoRequest: false,
    })
  );
};

describe('RequestDispatchManager', () => {
  beforeEach(() => mock.restoreAll());

  it('persists with the source transaction and disappears on rollback', async () => {
    const request = await createPendingRequest();
    const manager = new RequestDispatchManager();
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await manager.enqueue(request.id, queryRunner);
      assert.strictEqual(
        await queryRunner.manager.getRepository(RequestDispatchOutbox).count(),
        1
      );
      await queryRunner.rollbackTransaction();
      manager.rollback(queryRunner);
      await manager.resume();
      await waitForBackgroundTasks();
      assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      manager.rollback(queryRunner);
      await queryRunner.release();
    }
  });

  it('is inserted and rolled back by the real request subscriber', async (t) => {
    let dispatches = 0;
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async () => {
        dispatches += 1;
        return { delivered: true };
      }
    );
    t.after(() => dispatchMock.mock.restore());
    const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 67890,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    await assert.rejects(
      dataSource.transaction(async (manager) => {
        await manager.save(
          new MediaRequest({
            type: MediaType.MOVIE,
            status: MediaRequestStatus.APPROVED,
            media,
            requestedBy,
            is4k: false,
            isAutoRequest: false,
          })
        );
        assert.strictEqual(
          await manager.getRepository(RequestDispatchOutbox).count(),
          1
        );
        throw new Error('force request rollback');
      }),
      /force request rollback/
    );
    await waitForBackgroundTasks();

    assert.strictEqual(dispatches, 0);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('dispatches the real subscriber record only after commit', async (t) => {
    let release: (() => void) | undefined;
    let dispatches = 0;
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async () => {
        dispatches += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { delivered: true };
      }
    );
    t.after(() => dispatchMock.mock.restore());
    const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 67891,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    await dataSource.transaction(async (manager) => {
      await manager.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
          isAutoRequest: false,
        })
      );
      assert.strictEqual(dispatches, 0);
      assert.strictEqual(
        await manager.getRepository(RequestDispatchOutbox).count(),
        1
      );
    });
    for (let attempt = 0; attempt < 100 && !release; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.strictEqual(dispatches, 1);
    assert.ok(release);
    release();
    await waitForBackgroundTasks();
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('starts each dispatch outside the context that queued it', async (t) => {
    const caller = new AsyncLocalStorage<string>();
    const seen = new Map<number, string | undefined>();
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async (requestId: number) => {
        seen.set(requestId, caller.getStore());
        return { delivered: true };
      }
    );
    t.after(() => dispatchMock.mock.restore());
    const immediate = await createPendingRequest(67892);
    const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 67893,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    // A route's or a job's admission ends before the dispatches it queued.
    await caller.run('admission', async () => {
      await new RequestDispatchManager().enqueue(immediate.id);
      // Queued with the transaction and started by its commit.
      await dataSource.transaction((manager) =>
        manager.save(
          new MediaRequest({
            type: MediaType.MOVIE,
            status: MediaRequestStatus.APPROVED,
            media,
            requestedBy,
            is4k: false,
            isAutoRequest: false,
          })
        )
      );
    });
    await waitForBackgroundTasks();

    assert.strictEqual(seen.size, 2);
    assert.deepStrictEqual([...seen.values()], [undefined, undefined]);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('uses one database claim across competing workers', async (t) => {
    const request = await createPendingRequest();
    await getRepository(RequestDispatchOutbox).save(
      new RequestDispatchOutbox({ requestId: request.id, attempts: 0 })
    );
    let dispatches = 0;
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async () => {
        dispatches += 1;
        return { delivered: true };
      }
    );
    t.after(() => dispatchMock.mock.restore());

    const first = new RequestDispatchManager();
    const second = new RequestDispatchManager();
    await Promise.all([first.resume(), second.resume()]);
    await waitForBackgroundTasks();

    assert.strictEqual(dispatches, 1);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('bounds concurrent durable request dispatches', async (t) => {
    const requests: MediaRequest[] = [];
    for (let index = 0; index < REQUEST_DISPATCH_CONCURRENCY + 3; index += 1) {
      requests.push(await createPendingRequest(70000 + index));
    }
    await getRepository(RequestDispatchOutbox).save(
      requests.map(
        (mediaRequest) =>
          new RequestDispatchOutbox({
            requestId: mediaRequest.id,
            attempts: 0,
          })
      )
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await held;
        active -= 1;
        return { delivered: true };
      }
    );
    t.after(async () => {
      release();
      dispatchMock.mock.restore();
      await waitForBackgroundTasks();
    });

    await new RequestDispatchManager().resume();
    for (
      let attempt = 0;
      attempt < 100 && maximumActive < REQUEST_DISPATCH_CONCURRENCY;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }

    assert.strictEqual(maximumActive, REQUEST_DISPATCH_CONCURRENCY);
    release();
    await waitForBackgroundTasks();
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('retains and dispatches records created before a long shutdown', async (t) => {
    const request = await createPendingRequest();
    await getRepository(RequestDispatchOutbox).save(
      new RequestDispatchOutbox({
        requestId: request.id,
        attempts: 0,
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      })
    );
    let dispatches = 0;
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async () => {
        dispatches += 1;
        return { delivered: true };
      }
    );
    t.after(() => dispatchMock.mock.restore());

    await new RequestDispatchManager().resume();
    await waitForBackgroundTasks();

    assert.strictEqual(dispatches, 1);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('releases failed attempts for a later retry', async (t) => {
    const request = await createPendingRequest();
    await getRepository(RequestDispatchOutbox).save(
      new RequestDispatchOutbox({ requestId: request.id, attempts: 0 })
    );
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async () => ({ delivered: false })
    );
    t.after(() => dispatchMock.mock.restore());
    const manager = new RequestDispatchManager();

    await manager.resume();
    await waitForBackgroundTasks();

    const pending = await getRepository(RequestDispatchOutbox).findOneByOrFail({
      requestId: request.id,
    });
    assert.strictEqual(pending.attempts, 1);
    assert.strictEqual(pending.claimToken, null);
    assert.strictEqual(pending.claimedAt, null);
    assert.ok(pending.nextAttemptAt);
  });

  it('persists provider-directed retry delays across manager restarts', async (t) => {
    const request = await createPendingRequest();
    await getRepository(RequestDispatchOutbox).save(
      new RequestDispatchOutbox({ requestId: request.id, attempts: 0 })
    );
    let dispatches = 0;
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async () => {
        dispatches += 1;
        return dispatches === 1
          ? { delivered: false, retryAfterMs: 60 * 60 * 1000 }
          : { delivered: true };
      }
    );
    t.after(() => dispatchMock.mock.restore());

    await new RequestDispatchManager().resume();
    await waitForBackgroundTasks();
    const pending = await getRepository(RequestDispatchOutbox).findOneByOrFail({
      requestId: request.id,
    });
    assert.ok(
      pending.nextAttemptAt &&
        pending.nextAttemptAt.getTime() >= Date.now() + 59 * 60 * 1000
    );

    await new RequestDispatchManager().resume(false);
    await waitForBackgroundTasks();
    assert.strictEqual(dispatches, 1);

    pending.nextAttemptAt = new Date(Date.now() - 1);
    await getRepository(RequestDispatchOutbox).save(pending);
    await new RequestDispatchManager().resume(false);
    await waitForBackgroundTasks();
    assert.strictEqual(dispatches, 2);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('atomically fails approved requests when dispatch attempts are exhausted', async (t) => {
    const request = await createPendingRequest();
    await getRepository(MediaRequest).update(request.id, {
      status: MediaRequestStatus.APPROVED,
    });
    await getRepository(RequestDispatchOutbox).save(
      new RequestDispatchOutbox({
        requestId: request.id,
        attempts: 49,
      })
    );
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async () => ({ delivered: false })
    );
    const notificationMock = mock.method(
      notificationManager,
      'sendNotificationIntent',
      async () => undefined
    );
    t.after(() => {
      dispatchMock.mock.restore();
      notificationMock.mock.restore();
    });

    await new RequestDispatchManager().resume();
    await waitForBackgroundTasks();

    const failed = await getRepository(MediaRequest).findOneByOrFail({
      id: request.id,
    });
    assert.strictEqual(failed.status, MediaRequestStatus.FAILED);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
    assert.strictEqual(notificationMock.mock.callCount(), 1);
    assert.strictEqual(
      notificationMock.mock.calls[0].arguments[0],
      Notification.MEDIA_FAILED
    );
  });

  it('respects retry backoff during periodic scans', async (t) => {
    const request = await createPendingRequest();
    const record = await getRepository(RequestDispatchOutbox).save(
      new RequestDispatchOutbox({
        requestId: request.id,
        attempts: 2,
        lastAttemptAt: new Date(),
      })
    );
    let dispatches = 0;
    const dispatchMock = mock.method(
      MediaRequestSubscriber.prototype,
      'dispatchRequestById',
      async () => {
        dispatches += 1;
        return { delivered: true };
      }
    );
    t.after(() => dispatchMock.mock.restore());
    const manager = new RequestDispatchManager();

    await manager.resume(true);
    await waitForBackgroundTasks();
    assert.strictEqual(dispatches, 0);

    record.lastAttemptAt = new Date(
      Date.now() - getRequestDispatchRetryDelayMs(record.attempts) - 1
    );
    await getRepository(RequestDispatchOutbox).save(record);
    await manager.resume(true);
    await waitForBackgroundTasks();

    assert.strictEqual(dispatches, 1);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
  });

  it('cancels an unclaimed dispatch transactionally', async () => {
    const request = await createPendingRequest();
    const manager = new RequestDispatchManager();
    await getRepository(RequestDispatchOutbox).save(
      new RequestDispatchOutbox({ requestId: request.id, attempts: 0 })
    );
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await manager.cancel(request.id, queryRunner);
      assert.strictEqual(
        await queryRunner.manager.getRepository(RequestDispatchOutbox).count(),
        0
      );
      await queryRunner.rollbackTransaction();
      assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 1);

      await queryRunner.startTransaction();
      await manager.cancel(request.id, queryRunner);
      await queryRunner.commitTransaction();
      assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      await queryRunner.release();
    }
  });

  it('does not cancel a dispatch for a partial update without status', async (t) => {
    const cancelMock = mock.method(
      // The subscriber singleton is the production collaborator used here.
      (await import('.')).default,
      'cancel',
      async () => undefined
    );
    t.after(() => cancelMock.mock.restore());

    await new MediaRequestSubscriber().afterUpdate({
      entity: { id: 12345 },
      queryRunner: dataSource.createQueryRunner(),
    } as never);

    assert.strictEqual(cancelMock.mock.callCount(), 0);
  });
});

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { NotificationOutbox } from '@server/entity/NotificationOutbox';
import { RequestDispatchOutbox } from '@server/entity/RequestDispatchOutbox';
import { User } from '@server/entity/User';
import notificationManager, {
  Notification,
  NotificationManager,
} from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import requestDispatchManager, {
  RequestDispatchManager,
} from '@server/lib/requestDispatch';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type {
  EntitySubscriberInterface,
  QueryRunner,
  TransactionCommitEvent,
  TransactionRollbackEvent,
  TransactionStartEvent,
} from 'typeorm';
import {
  TransactionDeferrals,
  getTransactionDepth,
} from './transactionDeferrals';

type FakeRunner = { isTransactionActive: boolean; transactionDepth?: number };

const fakeRunner = (isTransactionActive = true, transactionDepth = 1) => {
  const runner: FakeRunner = { isTransactionActive, transactionDepth };
  return {
    runner,
    queryRunner: runner as unknown as QueryRunner,
    enter: () => {
      runner.isTransactionActive = true;
      runner.transactionDepth = (runner.transactionDepth ?? 0) + 1;
    },
    leave: () => {
      runner.transactionDepth = (runner.transactionDepth ?? 1) - 1;
      runner.isTransactionActive = runner.transactionDepth > 0;
    },
  };
};

const repeat = <T>(times: number, callback: () => T): T[] =>
  Array.from({ length: times }, callback);

describe('TransactionDeferrals', () => {
  it('hands work to the outermost commit in the order it was queued', () => {
    const deferrals = new TransactionDeferrals<string>();
    const { queryRunner, enter, leave } = fakeRunner();

    deferrals.add(queryRunner, 'outer');
    enter();
    deferrals.add(queryRunner, 'released');
    leave();
    assert.deepStrictEqual(
      repeat(3, () => deferrals.commit(queryRunner)),
      [[], [], []]
    );
    deferrals.add(queryRunner, 'after release');
    leave();

    assert.deepStrictEqual(
      repeat(3, () => deferrals.commit(queryRunner)),
      [['outer', 'released', 'after release'], [], []]
    );
  });

  it('discards only the work of a savepoint that rolls back', () => {
    const deferrals = new TransactionDeferrals<string>();
    const { queryRunner, enter, leave } = fakeRunner();

    deferrals.add(queryRunner, 'outer');
    enter();
    deferrals.add(queryRunner, 'rolled back');
    leave();
    assert.deepStrictEqual(
      repeat(3, () => deferrals.rollback(queryRunner)),
      [['rolled back'], [], []]
    );
    leave();

    assert.deepStrictEqual(deferrals.commit(queryRunner), ['outer']);
  });

  it('rolls back released work with the savepoint that enclosed it', () => {
    const deferrals = new TransactionDeferrals<string>();
    const { queryRunner, enter, leave } = fakeRunner();

    deferrals.add(queryRunner, 'outer');
    enter();
    deferrals.add(queryRunner, 'middle');
    enter();
    deferrals.add(queryRunner, 'inner');
    leave();
    assert.deepStrictEqual(deferrals.commit(queryRunner), []);
    leave();
    assert.deepStrictEqual(deferrals.rollback(queryRunner), [
      'middle',
      'inner',
    ]);
    leave();

    assert.deepStrictEqual(deferrals.commit(queryRunner), ['outer']);
  });

  it('discards everything when the outermost transaction rolls back', () => {
    const deferrals = new TransactionDeferrals<string>();
    const { queryRunner, enter, leave } = fakeRunner();

    deferrals.add(queryRunner, 'outer');
    enter();
    deferrals.add(queryRunner, 'released');
    leave();
    deferrals.commit(queryRunner);
    leave();

    assert.deepStrictEqual(
      repeat(3, () => deferrals.rollback(queryRunner)),
      [['outer', 'released'], [], []]
    );
    assert.deepStrictEqual(deferrals.commit(queryRunner), []);
  });

  it('keeps each query runner apart and can discard one runner', () => {
    const deferrals = new TransactionDeferrals<string>();
    const first = fakeRunner();
    const second = fakeRunner();

    deferrals.add(first.queryRunner, 'first');
    deferrals.add(second.queryRunner, 'second');

    assert.strictEqual(
      deferrals.some(first.queryRunner, (item) => item === 'first'),
      true
    );
    assert.strictEqual(
      deferrals.some(first.queryRunner, (item) => item === 'second'),
      false
    );
    assert.deepStrictEqual(deferrals.discard(first.queryRunner), ['first']);
    assert.deepStrictEqual(deferrals.discard(first.queryRunner), []);
    second.leave();
    assert.deepStrictEqual(deferrals.commit(second.queryRunner), ['second']);
  });

  it('counts an active transaction as one level when no depth is known', () => {
    const depthOf = (runner: Record<string, unknown>) =>
      getTransactionDepth(runner as unknown as QueryRunner);

    assert.strictEqual(depthOf({ isTransactionActive: false }), 0);
    assert.strictEqual(depthOf({ isTransactionActive: true }), 1);
    assert.strictEqual(
      depthOf({ isTransactionActive: true, transactionDepth: -1 }),
      1
    );
    assert.strictEqual(
      depthOf({ isTransactionActive: true, transactionDepth: '2' }),
      1
    );
    assert.strictEqual(
      depthOf({ isTransactionActive: true, transactionDepth: 3 }),
      3
    );
  });
});

const payload: NotificationPayload = {
  subject: 'Deferred notification',
  notifySystem: true,
  notifyAdmin: true,
};

type HookRecord = [string, boolean, number];

const addSubscriber = (
  subscriber: EntitySubscriberInterface,
  { first = false } = {}
): (() => void) => {
  if (first) {
    dataSource.subscribers.unshift(subscriber);
  } else {
    dataSource.subscribers.push(subscriber);
  }
  return () => {
    const index = dataSource.subscribers.indexOf(subscriber);
    if (index !== -1) {
      dataSource.subscribers.splice(index, 1);
    }
  };
};

const createPendingRequest = async (tmdbId: number): Promise<MediaRequest> => {
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

const deferredDispatches = (manager: RequestDispatchManager): Set<number> =>
  (manager as unknown as { deferred: Set<number> }).deferred;

const deferredDeliveries = (manager: NotificationManager): Set<number> =>
  (manager as unknown as { deferredOutboxDeliveries: Set<number> })
    .deferredOutboxDeliveries;

// Fresh managers drained through the real transaction events, three times
// per event as the three subscribers that drain the shared managers do.
const createDrainedManagers = () => {
  const dispatchManager = new RequestDispatchManager();
  const notifications = new NotificationManager();
  notifications.registerAgents([
    { shouldSend: () => true, send: async () => true },
  ]);
  const dispatched: { requestId: number; transactionActive: boolean }[] = [];
  const delivered: { id: number; transactionActive: boolean }[] = [];
  let currentRunner: QueryRunner | undefined;
  mock.method(
    dispatchManager as unknown as {
      dispatch: (record: RequestDispatchOutbox) => void;
    },
    'dispatch',
    (record: RequestDispatchOutbox) => {
      dispatched.push({
        requestId: record.requestId,
        transactionActive: Boolean(currentRunner?.isTransactionActive),
      });
    }
  );
  mock.method(
    notifications as unknown as {
      dispatchOutboxRecord: (record: NotificationOutbox) => void;
    },
    'dispatchOutboxRecord',
    (record: NotificationOutbox) => {
      delivered.push({
        id: record.id,
        transactionActive: Boolean(currentRunner?.isTransactionActive),
      });
    }
  );
  const removeSubscriber = addSubscriber({
    afterTransactionCommit: ({ queryRunner }: TransactionCommitEvent) => {
      currentRunner = queryRunner;
      for (let call = 0; call < 3; call += 1) {
        notifications.commitDeferredNotifications(queryRunner);
        dispatchManager.commit(queryRunner);
      }
    },
    afterTransactionRollback: ({ queryRunner }: TransactionRollbackEvent) => {
      currentRunner = queryRunner;
      for (let call = 0; call < 3; call += 1) {
        notifications.rollbackDeferredNotifications(queryRunner);
        dispatchManager.rollback(queryRunner);
      }
    },
  });
  return {
    dispatchManager,
    notifications,
    dispatched,
    delivered,
    removeSubscriber,
  };
};

describe('deferred work on a real transaction', () => {
  setupTestDb();
  beforeEach(() => mock.restoreAll());

  it('sees a savepoint end as an active transaction one level up', async (t) => {
    const hooks: HookRecord[] = [];
    const record =
      (name: string) =>
      ({
        queryRunner,
      }:
        | TransactionStartEvent
        | TransactionCommitEvent
        | TransactionRollbackEvent) => {
        hooks.push([
          name,
          queryRunner.isTransactionActive,
          getTransactionDepth(queryRunner),
        ]);
      };
    t.after(
      addSubscriber({
        afterTransactionStart: record('start'),
        afterTransactionCommit: record('commit'),
        afterTransactionRollback: record('rollback'),
      })
    );

    await dataSource.transaction(async (manager) => {
      await manager.transaction(async () => undefined);
      await assert.rejects(
        manager.transaction(async () => {
          throw new Error('roll back the savepoint');
        }),
        /roll back the savepoint/
      );
    });
    await assert.rejects(
      dataSource.transaction(async () => {
        throw new Error('roll back the transaction');
      }),
      /roll back the transaction/
    );

    assert.deepStrictEqual(hooks, [
      ['start', true, 1],
      ['start', true, 2],
      ['commit', true, 1],
      ['start', true, 2],
      ['rollback', true, 1],
      ['commit', false, 0],
      ['start', true, 1],
      ['rollback', false, 0],
    ]);
  });

  it('dispatches and notifies only after the outermost commit', async (t) => {
    const outer = await createPendingRequest(81001);
    const released = await createPendingRequest(81002);
    const discarded = await createPendingRequest(81003);
    const {
      dispatchManager,
      notifications,
      dispatched,
      delivered,
      removeSubscriber,
    } = createDrainedManagers();
    t.after(removeSubscriber);

    await dataSource.transaction(async (manager) => {
      await dispatchManager.enqueue(outer.id, manager.queryRunner);
      await notifications.sendNotification(
        Notification.MEDIA_AVAILABLE,
        payload,
        manager.queryRunner
      );
      await manager.transaction(async (savepoint) => {
        await dispatchManager.enqueue(released.id, savepoint.queryRunner);
        await notifications.sendNotification(
          Notification.MEDIA_AVAILABLE,
          payload,
          savepoint.queryRunner
        );
      });
      await assert.rejects(
        manager.transaction(async (savepoint) => {
          await dispatchManager.enqueue(discarded.id, savepoint.queryRunner);
          await notifications.sendNotification(
            Notification.MEDIA_AVAILABLE,
            payload,
            savepoint.queryRunner
          );
          throw new Error('roll back the savepoint');
        }),
        /roll back the savepoint/
      );
      assert.deepStrictEqual(dispatched, []);
      assert.deepStrictEqual(delivered, []);
    });
    await waitForBackgroundTasks();

    assert.deepStrictEqual(dispatched, [
      { requestId: outer.id, transactionActive: false },
      { requestId: released.id, transactionActive: false },
    ]);
    const outbox = await getRepository(NotificationOutbox).find({
      order: { id: 'ASC' },
    });
    assert.strictEqual(outbox.length, 2);
    assert.deepStrictEqual(
      delivered,
      outbox.map(({ id }) => ({ id, transactionActive: false }))
    );
    assert.deepStrictEqual(
      (
        await getRepository(RequestDispatchOutbox).find({
          order: { requestId: 'ASC' },
        })
      ).map(({ requestId }) => requestId),
      [outer.id, released.id]
    );
    assert.strictEqual(deferredDispatches(dispatchManager).size, 0);
    assert.strictEqual(deferredDeliveries(notifications).size, 0);
  });

  it('discards all deferred work when the outermost transaction rolls back', async (t) => {
    const outer = await createPendingRequest(81011);
    const released = await createPendingRequest(81012);
    const {
      dispatchManager,
      notifications,
      dispatched,
      delivered,
      removeSubscriber,
    } = createDrainedManagers();
    t.after(removeSubscriber);

    await assert.rejects(
      dataSource.transaction(async (manager) => {
        await dispatchManager.enqueue(outer.id, manager.queryRunner);
        await notifications.sendNotification(
          Notification.MEDIA_AVAILABLE,
          payload,
          manager.queryRunner
        );
        await manager.transaction(async (savepoint) => {
          await dispatchManager.enqueue(released.id, savepoint.queryRunner);
          await notifications.sendNotification(
            Notification.MEDIA_AVAILABLE,
            payload,
            savepoint.queryRunner
          );
        });
        throw new Error('roll back the transaction');
      }),
      /roll back the transaction/
    );
    await waitForBackgroundTasks();

    assert.deepStrictEqual(dispatched, []);
    assert.deepStrictEqual(delivered, []);
    assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
    assert.strictEqual(await getRepository(NotificationOutbox).count(), 0);
    assert.strictEqual(deferredDispatches(dispatchManager).size, 0);
    assert.strictEqual(deferredDeliveries(notifications).size, 0);
  });

  it('discards deferred work whose transaction never reported its end', async (t) => {
    const request = await createPendingRequest(81021);
    notificationManager.registerAgents([
      { shouldSend: () => true, send: async () => true },
    ]);
    t.after(() => notificationManager.registerAgents([]));
    let failRollbackBroadcast = true;
    // A subscriber ahead of the others that throws stops the rollback event
    // before the subscribers that drain the shared managers see it.
    t.after(
      addSubscriber(
        {
          afterTransactionRollback: () => {
            if (failRollbackBroadcast) {
              throw new Error('rollback event failed');
            }
          },
        },
        { first: true }
      )
    );

    await assert.rejects(
      dataSource.transaction(async (manager) => {
        await requestDispatchManager.enqueue(request.id, manager.queryRunner);
        await notificationManager.sendNotification(
          Notification.MEDIA_AVAILABLE,
          payload,
          manager.queryRunner
        );
        throw new Error('roll back the transaction');
      }),
      /roll back the transaction/
    );
    failRollbackBroadcast = false;
    assert.strictEqual(deferredDispatches(requestDispatchManager).size, 1);
    assert.strictEqual(deferredDeliveries(notificationManager).size, 1);
    const warn = mock.method(logger, 'warn', () => logger);

    await dataSource.transaction(async () => undefined);

    assert.strictEqual(deferredDispatches(requestDispatchManager).size, 0);
    assert.strictEqual(deferredDeliveries(notificationManager).size, 0);
    assert.deepStrictEqual(
      warn.mock.calls
        .map(({ arguments: args }) => (args as unknown[])[1])
        .filter(
          (meta): meta is { label: string; count: number } =>
            typeof meta === 'object' && meta !== null && 'count' in meta
        )
        .map(({ label, count }) => [label, count])
        .sort(),
      [
        ['Notifications', 1],
        ['Request Dispatch', 1],
      ]
    );
  });
});

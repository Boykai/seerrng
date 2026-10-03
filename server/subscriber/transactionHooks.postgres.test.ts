import type { MediaRequest as MediaRequestEntity } from '@server/entity/MediaRequest';
import type { NotificationOutbox as NotificationOutboxEntity } from '@server/entity/NotificationOutbox';
import type { RequestDispatchOutbox as RequestDispatchOutboxEntity } from '@server/entity/RequestDispatchOutbox';
import {
  runsOnPostgres,
  setupPostgresApplication,
} from '@server/test/postgresApplication';
import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';
import type {
  EntityManager,
  EntitySubscriberInterface,
  QueryRunner,
  TransactionCommitEvent,
  TransactionRollbackEvent,
  TransactionStartEvent,
} from 'typeorm';

// These tests need Node's test runner and SEERR_TEST_POSTGRES_URL. The
// PostgreSQL step of the migration checks provides both.
const postgresIt = runsOnPostgres ? it : it.skip;
const application = setupPostgresApplication();

// The application is loaded only after it points at this run's database.
const loadModules = async () => {
  const { MediaRequestStatus, MediaStatus, MediaType } =
    await import('@server/constants/media');
  const { default: dataSource, getRepository } =
    await import('@server/datasource');
  const { default: Media } = await import('@server/entity/Media');
  const { MediaRequest } = await import('@server/entity/MediaRequest');
  const { NotificationOutbox } =
    await import('@server/entity/NotificationOutbox');
  const { RequestDispatchOutbox } =
    await import('@server/entity/RequestDispatchOutbox');
  const { User } = await import('@server/entity/User');
  const { default: notificationManager } =
    await import('@server/lib/notifications');
  const { default: requestDispatchManager } =
    await import('@server/lib/requestDispatch');
  const { MediaRequestSubscriber } =
    await import('@server/subscriber/MediaRequestSubscriber');
  const { waitForBackgroundTasks } =
    await import('@server/utils/backgroundTasks');
  const { getTransactionDepth } =
    await import('@server/utils/transactionDeferrals');
  return {
    MediaRequestStatus,
    MediaStatus,
    MediaType,
    dataSource,
    getRepository,
    Media,
    MediaRequest,
    NotificationOutbox,
    RequestDispatchOutbox,
    User,
    notificationManager,
    requestDispatchManager,
    MediaRequestSubscriber,
    waitForBackgroundTasks,
    getTransactionDepth,
  };
};

let modules: Awaited<ReturnType<typeof loadModules>>;

if (runsOnPostgres) {
  before(async () => {
    await application.ready();
    modules = await loadModules();
  });

  afterEach(async () => {
    await modules?.waitForBackgroundTasks();
    mock.restoreAll();
    modules?.notificationManager.registerAgents([]);
  });
}

type HookRecord = [string, boolean, number];

const addSubscriber = (subscriber: EntitySubscriberInterface): (() => void) => {
  modules.dataSource.subscribers.push(subscriber);
  return () => {
    const index = modules.dataSource.subscribers.indexOf(subscriber);
    if (index !== -1) {
      modules.dataSource.subscribers.splice(index, 1);
    }
  };
};

const createPendingRequest = async (
  tmdbId: number
): Promise<MediaRequestEntity> => {
  const { getRepository, Media, MediaRequest, User } = modules;
  const { MediaRequestStatus, MediaStatus, MediaType } = modules;
  const requestedBy = await getRepository(User).findOneByOrFail({
    email: 'friend@seerr.dev',
  });
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

const approve = (manager: EntityManager, request: MediaRequestEntity) => {
  request.status = modules.MediaRequestStatus.APPROVED;
  return manager.getRepository(modules.MediaRequest).save(request);
};

// Records when deferred work is handed on and whether the transaction that
// queued it was still open. Dispatches are delivered for real; notification
// deliveries are only recorded, so their outbox rows stay.
const watchDeferredWork = () => {
  const { MediaRequestSubscriber, notificationManager } = modules;
  const dispatchManager = modules.requestDispatchManager as unknown as {
    dispatch: (record: RequestDispatchOutboxEntity) => void;
  };
  const deliverDispatch = dispatchManager.dispatch.bind(dispatchManager);
  const state: { runner?: QueryRunner } = {};
  const dispatched: { requestId: number; transactionOpen: boolean }[] = [];
  const delivered: number[] = [];
  const notified: { outboxId: number; transactionOpen: boolean }[] = [];
  const transactionOpen = () => Boolean(state.runner?.isTransactionActive);

  notificationManager.registerAgents([
    { shouldSend: () => true, send: async () => true },
  ]);
  mock.method(
    MediaRequestSubscriber.prototype,
    'dispatchRequestById',
    async (requestId: number) => {
      delivered.push(requestId);
      return { delivered: true };
    }
  );
  mock.method(
    dispatchManager,
    'dispatch',
    (record: RequestDispatchOutboxEntity) => {
      dispatched.push({
        requestId: record.requestId,
        transactionOpen: transactionOpen(),
      });
      deliverDispatch(record);
    }
  );
  mock.method(
    notificationManager as unknown as {
      dispatchOutboxRecord: (record: NotificationOutboxEntity) => void;
    },
    'dispatchOutboxRecord',
    (record: NotificationOutboxEntity) => {
      notified.push({
        outboxId: record.id,
        transactionOpen: transactionOpen(),
      });
    }
  );
  return { state, dispatched, delivered, notified };
};

const deferredCount = () => ({
  dispatches: (
    modules.requestDispatchManager as unknown as { deferred: Set<number> }
  ).deferred.size,
  notifications: (
    modules.notificationManager as unknown as {
      deferredOutboxDeliveries: Set<number>;
    }
  ).deferredOutboxDeliveries.size,
});

const notificationOutbox = () =>
  modules
    .getRepository(modules.NotificationOutbox)
    .find({ order: { id: 'ASC' } });

describe('deferred request work on PostgreSQL', () => {
  postgresIt(
    'reports a savepoint end as an active transaction one level up',
    async (t) => {
      const { dataSource, getTransactionDepth } = modules;
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
    }
  );

  postgresIt(
    'dispatches and notifies a request save only after the outermost commit',
    async (t) => {
      const { dataSource, getRepository, RequestDispatchOutbox } = modules;
      const request = await createPendingRequest(93001);
      const { state, dispatched, delivered, notified } = watchDeferredWork();
      const depths: number[] = [];
      t.after(
        addSubscriber({
          afterTransactionStart: ({ queryRunner }: TransactionStartEvent) => {
            if (queryRunner === state.runner) {
              depths.push(modules.getTransactionDepth(queryRunner));
            }
          },
        })
      );

      await dataSource.transaction(async (manager) => {
        state.runner = manager.queryRunner;
        await approve(manager, request);
        assert.deepStrictEqual(dispatched, []);
        assert.deepStrictEqual(notified, []);
      });
      await modules.waitForBackgroundTasks();

      // The save updated the media inside a savepoint of its own.
      assert.ok(depths.includes(2));
      assert.deepStrictEqual(dispatched, [
        { requestId: request.id, transactionOpen: false },
      ]);
      assert.deepStrictEqual(delivered, [request.id]);
      assert.strictEqual(await getRepository(RequestDispatchOutbox).count(), 0);
      const outbox = await notificationOutbox();
      assert.strictEqual(outbox.length, 1);
      assert.deepStrictEqual(notified, [
        { outboxId: outbox[0].id, transactionOpen: false },
      ]);
      assert.deepStrictEqual(deferredCount(), {
        dispatches: 0,
        notifications: 0,
      });
    }
  );

  postgresIt(
    'discards the deferred work of a save whose transaction rolls back',
    async () => {
      const { dataSource, getRepository, MediaRequest, MediaRequestStatus } =
        modules;
      const request = await createPendingRequest(93011);
      const { state, dispatched, delivered, notified } = watchDeferredWork();

      await assert.rejects(
        dataSource.transaction(async (manager) => {
          state.runner = manager.queryRunner;
          await approve(manager, request);
          throw new Error('roll back the transaction');
        }),
        /roll back the transaction/
      );
      await modules.waitForBackgroundTasks();

      assert.deepStrictEqual(dispatched, []);
      assert.deepStrictEqual(delivered, []);
      assert.deepStrictEqual(notified, []);
      assert.strictEqual(
        await getRepository(modules.RequestDispatchOutbox).count(),
        0
      );
      assert.deepStrictEqual(await notificationOutbox(), []);
      assert.strictEqual(
        (await getRepository(MediaRequest).findOneByOrFail({ id: request.id }))
          .status,
        MediaRequestStatus.PENDING
      );
      assert.deepStrictEqual(deferredCount(), {
        dispatches: 0,
        notifications: 0,
      });
    }
  );

  postgresIt(
    'discards only the work of a savepoint that rolls back',
    async () => {
      const { dataSource, getRepository, MediaRequest, MediaRequestStatus } =
        modules;
      const outer = await createPendingRequest(93021);
      const released = await createPendingRequest(93022);
      const rolledBack = await createPendingRequest(93023);
      const { state, dispatched, delivered, notified } = watchDeferredWork();

      await dataSource.transaction(async (manager) => {
        state.runner = manager.queryRunner;
        await approve(manager, outer);
        await manager.transaction((savepoint) => approve(savepoint, released));
        await assert.rejects(
          manager.transaction(async (savepoint) => {
            await approve(savepoint, rolledBack);
            throw new Error('roll back the savepoint');
          }),
          /roll back the savepoint/
        );
        assert.deepStrictEqual(dispatched, []);
        assert.deepStrictEqual(notified, []);
      });
      await modules.waitForBackgroundTasks();

      assert.deepStrictEqual(dispatched, [
        { requestId: outer.id, transactionOpen: false },
        { requestId: released.id, transactionOpen: false },
      ]);
      assert.deepStrictEqual(delivered.sort(), [outer.id, released.id].sort());
      const outbox = await notificationOutbox();
      assert.strictEqual(outbox.length, 2);
      assert.deepStrictEqual(
        notified,
        outbox.map(({ id }) => ({ outboxId: id, transactionOpen: false }))
      );
      assert.strictEqual(
        (
          await getRepository(MediaRequest).findOneByOrFail({
            id: rolledBack.id,
          })
        ).status,
        MediaRequestStatus.PENDING
      );
      assert.deepStrictEqual(deferredCount(), {
        dispatches: 0,
        notifications: 0,
      });
    }
  );
});

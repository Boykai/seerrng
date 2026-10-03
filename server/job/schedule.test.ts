import { MediaServerType } from '@server/constants/server';
import downloadRecovery from '@server/lib/downloadRecovery';
import episodeWatchAhead from '@server/lib/episodeWatchAhead';
import requestAdmissionCoordinator, {
  RequestAdmissionCoordinator,
} from '@server/lib/requestAdmission';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, it, mock } from 'node:test';
import type { DataSource, QueryRunner } from 'typeorm';
import { runTrackedJob, scheduledJobs, startJobs, stopJobs } from './schedule';

setupTestDb();

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
};

afterEach(async () => {
  await stopJobs();
  mock.restoreAll();
});

describe('scheduled job lifecycle', () => {
  it('does not start scheduled jobs in E2E test mode', () => {
    const previousE2eFlag = process.env.E2E_TESTS;
    process.env.E2E_TESTS = 'true';

    try {
      startJobs();
      assert.strictEqual(scheduledJobs.length, 0);
    } finally {
      if (previousE2eFlag === undefined) {
        delete process.env.E2E_TESTS;
      } else {
        process.env.E2E_TESTS = previousE2eFlag;
      }
    }
  });

  it('schedules the requested episode queue for every supported media server', async () => {
    const settings = getSettings();
    mock.method(episodeWatchAhead, 'run', async () => undefined);
    const previousMediaServerType = settings.main.mediaServerType;
    const previousWatchAheadSchedule =
      settings.jobs['jellyfin-watch-ahead'].schedule;

    try {
      settings.jobs['jellyfin-watch-ahead'].schedule = '*/30 * * * * *';
      settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
      startJobs();
      assert.equal(
        scheduledJobs.some((job) => job.id === 'jellyfin-watch-ahead'),
        false
      );

      for (const mediaServerType of [
        MediaServerType.PLEX,
        MediaServerType.JELLYFIN,
        MediaServerType.EMBY,
      ]) {
        await stopJobs();
        settings.main.mediaServerType = mediaServerType;
        startJobs();
        const watchAheadJob = scheduledJobs.find(
          (job) => job.id === 'jellyfin-watch-ahead'
        );
        assert.ok(watchAheadJob);
        assert.equal(watchAheadJob.name, 'Requested Episode Queue');
        assert.equal(watchAheadJob.interval, 'seconds');
        assert.equal(watchAheadJob.cronSchedule, '*/30 * * * * *');
      }
    } finally {
      settings.main.mediaServerType = previousMediaServerType;
      settings.jobs['jellyfin-watch-ahead'].schedule =
        previousWatchAheadSchedule;
    }
  });

  it('does not register duplicate jobs when startup runs twice', () => {
    const job = schedule.scheduleJob(
      new Date(Date.now() + 60_000),
      () => undefined
    );
    assert.ok(job);
    scheduledJobs.push({
      id: 'download-sync',
      job,
      name: 'Existing Job',
      type: 'command',
      interval: 'minutes',
      cronSchedule: '* * * * *',
    });

    startJobs();

    assert.strictEqual(scheduledJobs.length, 1);
    assert.strictEqual(scheduledJobs[0].job, job);
  });

  it('registers the BackIssue collection sync as a scheduled process task', () => {
    startJobs();

    const backissueJob = scheduledJobs.find(
      (job) => job.id === 'backissue-scan'
    );

    assert.ok(backissueJob);
    assert.equal(backissueJob.name, 'BackIssue Comics Scan');
    assert.equal(backissueJob.type, 'process');
    assert.equal(backissueJob.interval, 'hours');
    assert.equal(backissueJob.cronSchedule, '0 30 5 * * *');
    assert.equal(typeof backissueJob.cancelFn, 'function');
  });

  it('registers the manga library scan as a scheduled process task', () => {
    startJobs();

    const mangaJob = scheduledJobs.find(
      (job) => job.id === 'manga-library-scan'
    );

    assert.ok(mangaJob);
    assert.equal(mangaJob.name, 'Manga Library Scan');
    assert.equal(mangaJob.type, 'process');
    assert.equal(mangaJob.interval, 'hours');
    assert.equal(mangaJob.cronSchedule, '0 45 5 * * *');
    assert.equal(typeof mangaJob.cancelFn, 'function');
    assert.equal(mangaJob.running?.(), false);
  });

  it('registers the manga source resolver as a scheduled process task', () => {
    startJobs();

    const resolveJob = scheduledJobs.find(
      (job) => job.id === 'manga-source-resolve'
    );

    assert.ok(resolveJob);
    assert.equal(resolveJob.name, 'Manga Source Resolve');
    assert.equal(resolveJob.type, 'process');
    assert.equal(resolveJob.interval, 'minutes');
    assert.equal(resolveJob.cronSchedule, '0 */10 * * * *');
    assert.equal(typeof resolveJob.cancelFn, 'function');
    assert.equal(resolveJob.running?.(), false);
  });

  it('registers the manga dispatch sweep as a five-minute process task', () => {
    startJobs();

    const sweepJob = scheduledJobs.find(
      (job) => job.id === 'manga-dispatch-sweep'
    );

    assert.ok(sweepJob);
    assert.equal(sweepJob.name, 'Manga Dispatch Sweep');
    assert.equal(sweepJob.type, 'process');
    assert.equal(sweepJob.interval, 'minutes');
    assert.equal(sweepJob.cronSchedule, '0 */5 * * * *');
  });

  it('registers the manga progress poll as a two-minute process task', () => {
    startJobs();

    const progressJob = scheduledJobs.find(
      (job) => job.id === 'manga-progress'
    );

    assert.ok(progressJob);
    assert.equal(progressJob.name, 'Manga Progress');
    assert.equal(progressJob.type, 'process');
    assert.equal(progressJob.interval, 'minutes');
    assert.equal(progressJob.cronSchedule, '0 */2 * * * *');
    assert.equal(typeof progressJob.cancelFn, 'function');
    assert.equal(progressJob.running?.(), false);
  });

  it('registers the manga follow loop as a half-hourly process task', () => {
    startJobs();

    const followJob = scheduledJobs.find((job) => job.id === 'manga-follow');

    assert.ok(followJob);
    assert.equal(followJob.name, 'Manga Follow');
    assert.equal(followJob.type, 'process');
    assert.equal(followJob.interval, 'minutes');
    assert.equal(followJob.cronSchedule, '0 7,37 * * * *');
    assert.equal(typeof followJob.cancelFn, 'function');
    assert.equal(followJob.running?.(), false);
  });

  it('cancels future invocations and waits for active work', async () => {
    let cancelCalled = false;
    let release: (() => void) | undefined;
    const job = schedule.scheduleJob(
      new Date(Date.now() + 60_000),
      () => undefined
    );
    assert.ok(job);
    scheduledJobs.push({
      id: 'download-sync',
      job,
      name: 'Pending Job',
      type: 'command',
      interval: 'minutes',
      cronSchedule: '* * * * *',
      cancelFn: () => {
        cancelCalled = true;
      },
    });
    void runTrackedJob(
      'Held Job',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const stopping = stopJobs();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await waitFor(() => Boolean(release));

    assert.strictEqual(cancelCalled, true);
    assert.strictEqual(job.nextInvocation(), null);
    assert.strictEqual(stopped, false);
    assert.ok(release);

    release();
    await stopping;
    assert.strictEqual(stopped, true);
    assert.strictEqual(scheduledJobs.length, 0);
  });

  it('captures scheduled task failures without rejecting the drain', async () => {
    const errorMock = mock.method(logger, 'error', () => logger).mock;

    await runTrackedJob('Broken Job', async () => {
      throw new Error('job secret failure');
    });

    assert.strictEqual(errorMock.callCount(), 1);
    const logged = JSON.stringify(errorMock.calls[0].arguments);
    assert.match(logged, /Broken Job/);
    assert.match(logged, /job secret failure/);
    const [, metadata] = errorMock.calls[0].arguments as unknown as [
      string,
      { durationMs: number },
    ];
    assert.equal(typeof metadata.durationMs, 'number');
    assert.ok(metadata.durationMs >= 0);
  });

  it('logs completion and duration only when requested', async () => {
    const infoMock = mock.method(logger, 'info', () => logger).mock;

    await runTrackedJob('Quiet Job', async () => undefined);
    await runTrackedJob('Observed Job', async () => undefined, {
      logCompletion: true,
    });

    assert.strictEqual(infoMock.callCount(), 1);
    const [message, metadata] = infoMock.calls[0].arguments as unknown as [
      string,
      { durationMs: number; label: string },
    ];
    assert.match(message, /Observed Job/);
    assert.equal(metadata.label, 'Jobs');
    assert.equal(typeof metadata.durationMs, 'number');
    assert.ok(metadata.durationMs >= 0);
  });

  it('coalesces overlapping invocations of the same job', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const first = runTrackedJob('Single Flight Job', () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const overlapping = runTrackedJob('Single Flight Job', () => {
      calls += 1;
    });
    await waitFor(() => Boolean(release));

    assert.strictEqual(overlapping, first);
    assert.strictEqual(calls, 1);
    assert.ok(release);

    release();
    await first;
  });

  it('runs a job in its own async context, so it takes its own admission', async (t) => {
    const locks: string[] = [];
    let connections = 0;
    const source: Pick<DataSource, 'createQueryRunner'> = {
      createQueryRunner: () => {
        let connection = 0;
        const runner = {
          isTransactionActive: false,
          connect: async () => {
            connections += 1;
            connection = connections;
          },
          startTransaction: async () => {
            runner.isTransactionActive = true;
          },
          commitTransaction: async () => {
            runner.isTransactionActive = false;
          },
          rollbackTransaction: async () => {
            runner.isTransactionActive = false;
          },
          release: async () => undefined,
          query: async (_sql: string, parameters?: unknown[]) => {
            locks.push(`${connection}:${String(parameters?.[0])}`);
            return [];
          },
        };
        return runner as unknown as QueryRunner;
      },
    };
    const coordinator = new RequestAdmissionCoordinator(source, true, 2);
    const run: typeof requestAdmissionCoordinator.run = (keys, callback) =>
      coordinator.run(keys, callback);
    t.mock.method(requestAdmissionCoordinator, 'run', run);
    const caller = new AsyncLocalStorage<string>();
    let job: Promise<void> | undefined;
    let seen: string | undefined = 'not run';

    // Like the Run Now route: a handler inside an admission starts a job.
    await caller.run('route', () =>
      requestAdmissionCoordinator.run(['user-security:user:1'], async () => {
        job = runTrackedJob(
          'Detached Job',
          () =>
            requestAdmissionCoordinator.run(['job:detached'], async () => {
              seen = caller.getStore();
            }),
          { scope: 'instance' }
        );
      })
    );
    await job;

    assert.equal(seen, undefined);
    assert.deepEqual(locks, ['1:user-security:user:1', '2:job:detached']);
  });

  it('runs download recovery outside the context of the caller that starts it', async (t) => {
    const caller = new AsyncLocalStorage<string>();
    let seen: string | undefined = 'not run';
    t.mock.method(downloadRecovery, 'run', async () => {
      seen = caller.getStore();
    });
    startJobs();
    const recovery = scheduledJobs.find(
      (job) => job.id === 'download-recovery'
    );
    assert.ok(recovery);

    caller.run('route', () => recovery.job.invoke());
    await waitFor(() => seen !== 'not run');

    assert.equal(seen, undefined);
  });
});

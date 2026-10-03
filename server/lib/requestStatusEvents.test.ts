import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MediaRequestStatusEvent from '@server/entity/MediaRequestStatusEvent';
import { User } from '@server/entity/User';
import requestDispatchManager from '@server/lib/requestDispatch';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import {
  RequestStatusStage,
  getRequestStatusHistory,
  getRequestStatusPage,
  insertRequestStatusEvent,
  recordRequestCancellation,
  withStatusEventConflictTarget,
} from './requestStatus';

setupTestDb();

const REQUEST_ID = 9001;
const fingerprintOf = (stage: RequestStatusStage) =>
  `${stage}:0:unknown:unknown:unknown:0:unknown`;
const APPROVED = fingerprintOf(RequestStatusStage.APPROVED);
const FAILED = fingerprintOf(RequestStatusStage.FAILED);

const statusEvent = (
  stage: RequestStatusStage,
  fingerprint = fingerprintOf(stage),
  overrides: Partial<MediaRequestStatusEvent> = {}
) =>
  new MediaRequestStatusEvent({
    requestId: REQUEST_ID,
    requestedById: 2,
    mediaId: 1,
    mediaType: MediaType.MOVIE,
    stage,
    attempt: 0,
    downloadCount: 0,
    fingerprint,
    ...overrides,
  });

const eventsOf = (requestId = REQUEST_ID) =>
  getRepository(MediaRequestStatusEvent).find({
    where: { requestId },
    order: { id: 'ASC' },
  });

const latestOf = async (requestId = REQUEST_ID) =>
  (await eventsOf(requestId)).at(-1);

// Inserts after reading the latest event, as the status writers do.
const observe = async (
  stage: RequestStatusStage,
  fingerprint = fingerprintOf(stage),
  manager?: EntityManager
) =>
  insertRequestStatusEvent(statusEvent(stage, fingerprint), {
    latestEvent: await latestOf(),
    manager,
  });

const createMovieRequest = async (tmdbId: number): Promise<MediaRequest> => {
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

describe('request status event inserts', () => {
  beforeEach(() => mock.restoreAll());

  it('skips only a repeated fingerprint on both database drivers', () => {
    const sqlite = withStatusEventConflictTarget(
      getRepository(MediaRequestStatusEvent)
        .createQueryBuilder()
        .insert()
        .into(MediaRequestStatusEvent)
        .values(statusEvent(RequestStatusStage.APPROVED))
    ).getQuery();
    const postgres = withStatusEventConflictTarget(
      new DataSource({ type: 'postgres' })
        .createQueryBuilder()
        .insert()
        .into('media_request_status_event', ['requestId', 'fingerprint'])
        .values({ requestId: REQUEST_ID, fingerprint: APPROVED })
    ).getQuery();

    for (const sql of [sqlite, postgres]) {
      assert.match(
        sql,
        /ON CONFLICT \( "requestId", "fingerprint" \) DO NOTHING/
      );
      assert.doesNotMatch(sql, /ON CONFLICT DO NOTHING/);
    }
  });

  it('records a return to an earlier observation once, after the latest event', async () => {
    await observe(RequestStatusStage.APPROVED);
    await observe(RequestStatusStage.FAILED);
    await observe(RequestStatusStage.APPROVED);
    await observe(RequestStatusStage.APPROVED);

    const events = await eventsOf();
    assert.deepStrictEqual(
      events.map(({ stage, fingerprint }) => [stage, fingerprint]),
      [
        [RequestStatusStage.APPROVED, APPROVED],
        [RequestStatusStage.FAILED, FAILED],
        [RequestStatusStage.APPROVED, `${APPROVED}:after:${events[1].id}`],
      ]
    );
  });

  it('writes one row for writers that saw the same latest event', async () => {
    await observe(RequestStatusStage.APPROVED);
    const first = await latestOf();
    await observe(RequestStatusStage.FAILED);
    const seen = await latestOf();

    await Promise.all([
      insertRequestStatusEvent(statusEvent(RequestStatusStage.APPROVED), {
        latestEvent: seen,
      }),
      insertRequestStatusEvent(statusEvent(RequestStatusStage.APPROVED), {
        latestEvent: seen,
      }),
    ]);
    // A writer that read the latest event before the failure was recorded.
    await insertRequestStatusEvent(statusEvent(RequestStatusStage.FAILED), {
      latestEvent: first,
    });

    assert.deepStrictEqual(
      (await eventsOf()).map(({ fingerprint }) => fingerprint),
      [APPROVED, FAILED, `${APPROVED}:after:${seen?.id}`]
    );
  });

  it('records every return when a request cycles between two stages', async () => {
    for (const stage of [
      RequestStatusStage.APPROVED,
      RequestStatusStage.FAILED,
      RequestStatusStage.APPROVED,
      RequestStatusStage.FAILED,
      RequestStatusStage.APPROVED,
    ]) {
      await observe(stage);
    }

    const events = await eventsOf();
    assert.deepStrictEqual(
      events.map(({ fingerprint }) => fingerprint),
      [
        APPROVED,
        FAILED,
        `${APPROVED}:after:${events[1].id}`,
        `${FAILED}:after:${events[2].id}`,
        `${APPROVED}:after:${events[3].id}`,
      ]
    );
  });

  it('keeps a long re-entry fingerprint within its column', async () => {
    const long = `downloading:0:50.0:100:${'s'.repeat(300)}`.slice(0, 255);

    await observe(RequestStatusStage.DOWNLOADING, long);
    await observe(RequestStatusStage.FAILED);
    const failed = await latestOf();
    await observe(RequestStatusStage.DOWNLOADING, long);
    await observe(RequestStatusStage.DOWNLOADING, long);

    const events = await eventsOf();
    const reentry = events[2].fingerprint;
    assert.strictEqual(events.length, 3);
    assert.strictEqual(reentry.length, 255);
    assert.ok(reentry.endsWith(`:after:${failed?.id}`));
    assert.ok(long.startsWith(reentry.slice(0, reentry.indexOf(':after:'))));
  });

  it('still fails an insert that conflicts on another key', async () => {
    await observe(RequestStatusStage.APPROVED);
    const existing = await latestOf();
    const duplicateKey = statusEvent(
      RequestStatusStage.FAILED,
      FAILED,
      existing ? { id: existing.id } : {}
    );

    await assert.rejects(
      dataSource.transaction((manager) =>
        insertRequestStatusEvent(duplicateKey, { manager })
      ),
      /UNIQUE constraint failed: media_request_status_event\.id/
    );
    // A conflict clause without a target would hide the same conflict.
    await getRepository(MediaRequestStatusEvent)
      .createQueryBuilder()
      .insert()
      .into(MediaRequestStatusEvent)
      .values(duplicateKey)
      .orIgnore()
      .execute();
    assert.strictEqual((await eventsOf()).length, 1);
  });

  it('fails the transaction on any other insert error and only logs outside one', async () => {
    const warn = mock.method(logger, 'warn', () => logger);
    const invalid = statusEvent(RequestStatusStage.APPROVED, APPROVED, {
      requestedById: undefined,
    });

    await assert.rejects(
      dataSource.transaction((manager) =>
        insertRequestStatusEvent(invalid, { manager })
      ),
      /NOT NULL constraint failed/
    );
    assert.strictEqual(warn.mock.callCount(), 0);

    await insertRequestStatusEvent(invalid);
    assert.strictEqual(warn.mock.callCount(), 1);
    const [message, meta] = warn.mock.calls[0].arguments as unknown as [
      string,
      { requestId: number; errorMessage: string },
    ];
    assert.strictEqual(message, 'Unable to persist request status event');
    assert.strictEqual(meta.requestId, REQUEST_ID);
    assert.match(meta.errorMessage, /NOT NULL constraint failed/);
    assert.strictEqual((await eventsOf()).length, 0);
  });

  it('cuts long values to their column lengths', async () => {
    await dataSource.transaction((manager) =>
      insertRequestStatusEvent(
        statusEvent(RequestStatusStage.DOWNLOADING, 'downloading:long', {
          service: 's'.repeat(200),
          message: 'm'.repeat(600),
          downloadId: '\u{1F4D6}'.repeat(600),
          estimatedCompletionTime: new Date(Number.NaN),
        }),
        { manager }
      )
    );

    const [event] = await eventsOf();
    assert.strictEqual(event.service, 's'.repeat(128));
    assert.strictEqual(event.message, 'm'.repeat(512));
    assert.strictEqual(event.downloadId, '\u{1F4D6}'.repeat(512));
    assert.strictEqual(event.estimatedCompletionTime, null);
  });

  it('records a cancellation once when it is recorded twice in a transaction', async () => {
    const request = await createMovieRequest(91001);

    await dataSource.transaction(async (manager) => {
      await recordRequestCancellation(request, { manager });
      await recordRequestCancellation(request, { manager });
      await manager.query('SELECT 1');
    });

    assert.deepStrictEqual(
      (await eventsOf(request.id)).map(({ stage }) => stage),
      [RequestStatusStage.REQUESTED, RequestStatusStage.CANCELLED]
    );
  });

  it('counts a retried request by the stage it returned to', async () => {
    mock.method(
      requestDispatchManager as unknown as { dispatch: () => void },
      'dispatch',
      () => undefined
    );
    const request = await createMovieRequest(91002);
    const repository = getRepository(MediaRequest);
    const saveWithStatus = async (status: MediaRequestStatus) => {
      request.status = status;
      await repository.save(request);
    };

    await saveWithStatus(MediaRequestStatus.APPROVED);
    await saveWithStatus(MediaRequestStatus.FAILED);
    const failedPage = await getRequestStatusPage({ take: 10, skip: 0 });
    await saveWithStatus(MediaRequestStatus.APPROVED);
    const retriedPage = await getRequestStatusPage({ take: 10, skip: 0 });

    const events = await eventsOf(request.id);
    assert.deepStrictEqual(
      events.map(({ stage }) => stage),
      [
        RequestStatusStage.REQUESTED,
        RequestStatusStage.APPROVED,
        RequestStatusStage.FAILED,
        RequestStatusStage.APPROVED,
      ]
    );
    assert.strictEqual(
      events[3].fingerprint,
      `${events[1].fingerprint}:after:${events[2].id}`
    );
    assert.strictEqual(
      (await getRequestStatusHistory(request.id)).results[0].stage,
      RequestStatusStage.APPROVED
    );
    const countsOf = ({
      counts: { total, active, attention, failed },
    }: typeof failedPage) => ({ total, active, attention, failed });
    assert.deepStrictEqual(countsOf(failedPage), {
      total: 1,
      active: 0,
      attention: 1,
      failed: 1,
    });
    assert.deepStrictEqual(countsOf(retriedPage), {
      total: 1,
      active: 1,
      attention: 0,
      failed: 0,
    });
  });
});

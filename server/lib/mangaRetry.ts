import type SuwayomiAPI from '@server/api/suwayomi';
import {
  MangaChapterQueueState,
  MangaRequestBindingState,
  MangaRequestCheckpoint,
} from '@server/constants/mangaRequest';
import { MediaRequestStatus } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaLibraryOwnership from '@server/entity/MangaLibraryOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import { MediaRequest } from '@server/entity/MediaRequest';
import { runWithMangaDispatchLock } from '@server/lib/mangaDispatch';
import {
  assertSameInstance,
  countRows,
  isSameManga,
} from '@server/lib/mangaProgress';
import { isMangaChapterRetryable } from '@server/lib/requestStatus';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import { snapshotSuwayomiInstance } from '@server/lib/suwayomi/instanceAdmission';
import logger from '@server/logger';
import { chunk } from '@server/utils/chunk';
import { In, IsNull } from 'typeorm';

/*
 * An administrator's retry of an enqueued manga request: the frozen chapters
 * whose download failed, or that dropped out of the queue, are queued once
 * more. The dispatch steps are never rewound (that would fetch from the
 * source again), and nothing is deleted or dequeued.
 */

const LABEL = 'Manga Retry';
/** Chapter IDs per enqueue, as dispatch queues them. */
export const MANGA_RETRY_BATCH_SIZE = 50;

/** States of an unverified row the retry queues again. */
const RETRIED_STATES = new Set<string>([
  MangaChapterQueueState.ERROR,
  MangaChapterQueueState.NOT_QUEUED,
]);

export type MangaRetryClient = Pick<
  SuwayomiAPI,
  | 'findMangaByNaturalKey'
  | 'getChaptersToDownload'
  | 'getDownloadedChapters'
  | 'getQueue'
  | 'enqueueChapters'
>;

/** The retry can't run as asked; nothing was queued. */
export class MangaRetryRefusedError extends Error {
  public readonly status = 409;
}

export const MANGA_RETRY_STATE_MESSAGE =
  'This request cannot be retried from its current state.';

/** Rolls the final write back when the manifest moved under it. */
class ManifestMovedError extends Error {}

export interface MangaRetryResult {
  /** Chapters this retry queued. */
  enqueued: number;
  /** Chapters it found failed or not queued, the enqueued ones included. */
  candidates: number;
}

/** The manifest of an approved request whose chapters a retry can queue. */
const loadRetryable = (requestId: number) =>
  getRepository(MangaRequestManifest)
    .createQueryBuilder('manifest')
    .innerJoin('manifest.request', 'request')
    .where('manifest.requestId = :requestId', { requestId })
    .andWhere('request.status = :status', {
      status: MediaRequestStatus.APPROVED,
    })
    .andWhere('manifest.bindingState = :bindingState', {
      bindingState: MangaRequestBindingState.BOUND,
    })
    .andWhere('manifest.checkpoint = :checkpoint', {
      checkpoint: MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
    })
    .getOne();

const sameBinding = (
  manifest: MangaRequestManifest,
  expected: MangaRequestManifest
): boolean =>
  manifest.instanceId === expected.instanceId &&
  manifest.bindingSourceId === expected.bindingSourceId &&
  manifest.bindingUrlHash === expected.bindingUrlHash;

/** The source-relative URL of a bound manga, from its binding or library row. */
const mangaUrlOf = async (
  instanceId: number,
  sourceId: string,
  urlHash: string
): Promise<string | undefined> =>
  (
    await getRepository(MangaSourceBinding).findOne({
      where: { instanceId, sourceId, urlHash },
      order: { id: 'ASC' },
    })
  )?.url ??
  (
    await getRepository(MangaLibraryOwnership).findOne({
      where: { instanceId, sourceId, urlHash },
    })
  )?.url;

const retryUnderLock = async (
  expected: MangaRequestManifest,
  snapshot: SuwayomiSettings,
  client: MangaRetryClient
): Promise<MangaRetryResult> => {
  const manifest = await loadRetryable(expected.requestId);
  if (
    !manifest ||
    !sameBinding(manifest, expected) ||
    !isMangaChapterRetryable(manifest)
  ) {
    throw new MangaRetryRefusedError(MANGA_RETRY_STATE_MESSAGE);
  }
  const sourceId = manifest.bindingSourceId as string;
  const urlHash = manifest.bindingUrlHash as string;
  const rows = await getRepository(MangaRequestChapter).find({
    where: { manifestId: manifest.id },
    order: { id: 'ASC' },
  });
  const candidates = rows.filter(
    (row) =>
      row.deliverableAt === null &&
      row.lastQueueState !== null &&
      RETRIED_STATES.has(row.lastQueueState)
  );

  const pending: { row: MangaRequestChapter; chapterId: string }[] = [];
  if (candidates.length > 0) {
    const url = await mangaUrlOf(manifest.instanceId, sourceId, urlHash);
    const found =
      url === undefined
        ? undefined
        : await client.findMangaByNaturalKey(sourceId, url);
    if (!found || !isSameManga(found, { sourceId, urlHash })) {
      throw new MangaRetryRefusedError(
        "The connected manga service no longer has this request's manga."
      );
    }
    const waiting = await client.getChaptersToDownload(found.id);
    const downloaded = await client.getDownloadedChapters(found.id);
    const queue = await client.getQueue();

    const downloadedHashes = new Set(
      downloaded.map((chapter) => hashMangaSourceUrl(chapter.url))
    );
    const chapterIds = new Map<string, string>();
    for (const chapter of waiting) {
      const chapterHash = hashMangaSourceUrl(chapter.url);
      if (!chapterIds.has(chapterHash)) chapterIds.set(chapterHash, chapter.id);
    }
    const queued = new Map(queue.items.map((item) => [item.chapterId, item]));
    for (const row of candidates) {
      const chapterId = chapterIds.get(row.urlHash);
      if (chapterId === undefined || downloadedHashes.has(row.urlHash)) {
        continue;
      }
      const item = queued.get(chapterId);
      // A queued chapter waits its turn; a failed one gets one more attempt.
      if (item === undefined || item.state === 'ERROR') {
        pending.push({ row, chapterId });
      }
    }
  }

  for (const batch of chunk(pending, MANGA_RETRY_BATCH_SIZE)) {
    // Recorded before the enqueue, so L11's release can dequeue them later.
    await dataSource.transaction(async (manager) => {
      assertSameInstance(snapshot);
      await manager
        .createQueryBuilder()
        .insert()
        .into(MangaChapterOwnership)
        .values(
          batch.map(({ row }) => ({
            instanceId: manifest.instanceId,
            sourceId,
            mangaUrlHash: urlHash,
            chapterUrlHash: row.urlHash,
            chapterUrl: row.url,
          }))
        )
        .orIgnore()
        .execute();
    });
    await client.enqueueChapters(batch.map(({ chapterId }) => chapterId));
  }

  const enqueuedIds = new Set(pending.map(({ row }) => row.id));
  const progress = countRows(
    rows.map((row) =>
      enqueuedIds.has(row.id)
        ? {
            ...row,
            lastQueueState: MangaChapterQueueState.QUEUED,
            fileState: null,
          }
        : row
    )
  );
  try {
    await dataSource.transaction(async (manager) => {
      const approved = await manager
        .createQueryBuilder(MediaRequest, 'request')
        .where('request.id = :id', { id: manifest.requestId })
        .andWhere('request.status = :status', {
          status: MediaRequestStatus.APPROVED,
        })
        .getExists();
      if (!approved) throw new ManifestMovedError();
      assertSameInstance(snapshot);
      if (enqueuedIds.size > 0) {
        await manager
          .createQueryBuilder()
          .update(MangaRequestChapter)
          .set({
            lastQueueState: MangaChapterQueueState.QUEUED,
            fileState: null,
          })
          .where({
            id: In([...enqueuedIds]),
            manifestId: manifest.id,
            deliverableAt: IsNull(),
          })
          .execute();
      }
      // The next poll reads the chapter lists again, first in its cursor,
      // and raises any code whose cause is still there.
      const result = await manager
        .createQueryBuilder()
        .update(MangaRequestManifest)
        .set({
          chaptersTotal: progress.total,
          chaptersVerified: progress.verified,
          chaptersQueued: progress.queued,
          chaptersDownloading: progress.downloading,
          chaptersErrored: progress.errored,
          chaptersMissing: progress.missing,
          attentionCode: null,
          attentionAt: null,
          progressSignature: null,
          progressAt: null,
        })
        .where({
          id: manifest.id,
          instanceId: manifest.instanceId,
          bindingState: MangaRequestBindingState.BOUND,
          checkpoint: MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
          bindingSourceId: sourceId,
          bindingUrlHash: urlHash,
        })
        .execute();
      if (result.affected !== 1) throw new ManifestMovedError();
    });
  } catch (error) {
    if (!(error instanceof ManifestMovedError)) throw error;
    // The chapters are queued; L11's release takes back any no request needs.
    logger.info('A retried manga request moved before its progress write', {
      label: LABEL,
      requestId: manifest.requestId,
      count: pending.length,
    });
    return { enqueued: pending.length, candidates: candidates.length };
  }

  logger.info('Manga chapters queued again by an administrator', {
    label: LABEL,
    requestId: manifest.requestId,
    code: manifest.attentionCode,
    count: pending.length,
    skipped: candidates.length - pending.length,
  });
  return { enqueued: pending.length, candidates: candidates.length };
};

/**
 * Queues the failed and dropped chapters of an approved, enqueued manga
 * request once more, under the dispatch lock of its manga. Runs inside the
 * route's request admission, so it takes no instance admission: every write
 * transaction checks the instance against the snapshot taken before its
 * client was built, as dispatch does. Suwayomi errors reach the caller.
 */
export const retryMangaChapters = async (
  requestId: number,
  options: {
    /** Replaces the shared client factory; tests pass their own client. */
    clientFor?: (instanceId: number) => MangaRetryClient | undefined;
  } = {}
): Promise<MangaRetryResult> => {
  const manifest = await loadRetryable(requestId);
  if (
    !manifest ||
    !manifest.bindingSourceId ||
    !manifest.bindingUrlHash ||
    !isMangaChapterRetryable(manifest)
  ) {
    throw new MangaRetryRefusedError(MANGA_RETRY_STATE_MESSAGE);
  }
  const snapshot = snapshotSuwayomiInstance(manifest.instanceId);
  const client = snapshot
    ? (options.clientFor ?? getSuwayomiClient)(manifest.instanceId)
    : undefined;
  if (!snapshot || !client) {
    throw new MangaRetryRefusedError(
      'The manga service this request was sent to is no longer configured.'
    );
  }
  return runWithMangaDispatchLock(
    manifest.instanceId,
    manifest.bindingSourceId,
    manifest.bindingUrlHash,
    () => retryUnderLock(manifest, snapshot, client)
  );
};

import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import type MangaSourceBinding from '@server/entity/MangaSourceBinding';
import { countMangaDownloadSlots } from '@server/lib/mangaDownloadCopy';
import logger from '@server/logger';
import type { FakeReply, FakeRequest } from '@server/test/fakeSuwayomi';
import {
  FAKE_TITLE_PREFIX,
  FAKE_URL_PREFIX,
  fakeDispatchChapters,
  fakeDispatchManga,
  seedDispatchBinding,
  type FakeDispatchManga,
} from '@server/test/fakeSuwayomiDispatch';
import {
  seedProgressRequest,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';

/**
 * Fixtures for manga download copies: requests whose chapters the progress
 * poll verified, archive replies, and a log capture that proves no title,
 * URL or chapter name reaches a log line. All values are invented.
 */

/** The title the AniList stub gives every manga by default. */
export const DOWNLOAD_TITLE = 'Sample Manga';

/** A library manga whose chapters `numbers` are all downloaded. */
export const downloadedManga = (
  id: number,
  numbers: readonly number[] = [1, 2]
): FakeDispatchManga =>
  fakeDispatchManga(id, {
    inLibrary: true,
    chapters: fakeDispatchChapters(id, numbers, numbers),
  });

/** Marks rows delivered, as the poll does once a HEAD finds their file. */
export const deliver = async (
  rows: readonly Pick<MangaRequestChapter, 'id'>[]
): Promise<void> => {
  for (const row of rows) {
    await getRepository(MangaRequestChapter).update(row.id, {
      deliverableAt: new Date(),
    });
  }
};

/**
 * A request for `manga` through an ACTIVE binding, every frozen chapter
 * delivered unless `delivered` is false.
 */
export const seedDeliveredRequest = async (
  manga: FakeDispatchManga,
  {
    delivered = true,
    binding = {},
    ...options
  }: Parameters<typeof seedProgressRequest>[1] & {
    delivered?: boolean;
    binding?: Partial<MangaSourceBinding> | null;
  } = {}
) => {
  if (binding !== null) {
    await seedDispatchBinding(manga, {
      anilistId: options.anilistId ?? 9001,
      instanceId: options.instanceId ?? 1,
      ...binding,
    });
  }
  const seeded = await seedProgressRequest(manga, {
    mediaStatus: MediaStatus.PROCESSING,
    ...options,
  });
  if (delivered) await deliver(seeded.rows);
  return seeded;
};

/** A CBZ answer to an archive GET, sized unless `sized` is false. */
export const archiveReply = (body: string, sized = true): FakeReply => ({
  status: 200,
  headers: {
    'Content-Type': 'application/zip',
    ...(sized && { 'Content-Length': String(Buffer.byteLength(body)) }),
  },
  body,
});

export const archivePath = (chapterId: number) =>
  `/api/v1/chapter/${chapterId}/download`;

/** Scripts the archive GET of a chapter. */
export const serveArchive = (
  fake: FakeProgressSuwayomi,
  chapterId: number,
  ...replies: FakeReply[]
): void => fake.server.onRoute('GET', archivePath(chapterId), ...replies);

/** Every archive GET the fake received, in order. */
export const archiveGets = (fake: FakeProgressSuwayomi): FakeRequest[] =>
  fake.server.requests.filter(({ method }) => method === 'GET');

type Level = 'error' | 'warn' | 'info' | 'debug';
export type CapturedLog = [Level, string, Record<string, unknown>];

/** Captures every log line until the mocks are restored. */
export const captureLogs = (): CapturedLog[] => {
  const captured: CapturedLog[] = [];
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    mock.method(logger, level, (message: unknown, meta?: unknown) => {
      captured.push([
        level,
        String(message),
        (meta ?? {}) as Record<string, unknown>,
      ]);
      return logger;
    });
  }
  return captured;
};

/** The level and metadata of every captured line with `message`. */
export const logsOf = (logs: readonly CapturedLog[], message: string) =>
  logs
    .filter(([, text]) => text === message)
    .map(([level, , meta]) => [level, meta] as const);

/** Log lines name codes, counts and IDs: never a URL, a title or a chapter. */
export const assertPrivateLogs = (logs: readonly CapturedLog[]): void => {
  const text = inspect(logs, {
    depth: 12,
    maxArrayLength: null,
    maxStringLength: null,
  });
  for (const secret of [
    FAKE_URL_PREFIX,
    FAKE_TITLE_PREFIX,
    DOWNLOAD_TITLE,
    'Fake Chapter',
    '.cbz',
  ]) {
    assert.ok(!text.includes(secret), `A log line carried ${secret}`);
  }
};

/** Waits until every download slot is free again. */
export const slotsReleased = async (): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { users, instances } = countMangaDownloadSlots();
    if (users === 0 && instances === 0) return;
    await sleep(10);
  }
  assert.deepStrictEqual(countMangaDownloadSlots(), { users: 0, instances: 0 });
};

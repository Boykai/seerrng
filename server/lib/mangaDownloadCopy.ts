import AnilistAPI from '@server/api/anilist';
import { isAnilistMangaExcluded } from '@server/api/anilist/manga';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import type { SuwayomiByteStream } from '@server/api/suwayomi/types';
import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import { getRepository } from '@server/datasource';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { getMangaContentPolicy } from '@server/lib/mangaCatalog';
import { isKnownMangaChapterNumber } from '@server/lib/mangaRequests';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import type { Readable, Writable } from 'node:stream';
import { IsNull, Not } from 'typeorm';

/** Concurrent chapter downloads one user may run. */
export const MANGA_DOWNLOAD_STREAMS_PER_USER = 2;
/** Concurrent chapter downloads one Suwayomi server serves. */
export const MANGA_DOWNLOAD_STREAMS_PER_INSTANCE = 4;
/** What a 429 tells the browser to wait before trying again. */
export const MANGA_DOWNLOAD_RETRY_AFTER_SECONDS = 30;
/** A download stops once the client accepts no bytes for this long. */
export const MANGA_DOWNLOAD_STALL_MS = 120_000;
/** A download stops once it has run this long. */
export const MANGA_DOWNLOAD_TOTAL_MS = 1_800_000;
/** How long the listing waits for the shared AniList budget. */
const TITLE_RATE_LIMIT_WAIT_MS = 2_000;
/** Leaves room in the 255-character asset name for the chapter suffix. */
const TITLE_MAX_LENGTH = 200;

/** One verified chapter of a manga request, ready to stream as a CBZ. */
export interface MangaDownloadCopy {
  /** The file name the listing shows and the download sends. */
  name: string;
  instanceId: number;
  manifestId: number;
  /** URL hash of the chapter at its source. */
  urlHash: string;
  /** The manga the request is bound to, by its natural key. */
  manga: { sourceId: string; url: string; urlHash: string };
}

/** Why a guarded download was stopped. */
export class MangaDownloadLimitError extends Error {
  readonly code: 'STALLED' | 'TOTAL_TIME';

  constructor(code: 'STALLED' | 'TOTAL_TIME') {
    super(
      code === 'STALLED'
        ? 'The download client stopped accepting data.'
        : 'The download ran past its time limit.'
    );
    this.name = 'MangaDownloadLimitError';
    this.code = code;
  }
}

/** Log fields for a failure: codes and names only, never a message. */
export const getMangaDownloadErrorFields = (
  error: unknown
): Record<string, string | number> => {
  if (error instanceof SuwayomiError) {
    return {
      code: error.code,
      operation: error.operation,
      ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
    };
  }
  if (error instanceof MangaDownloadLimitError) return { code: error.code };
  return { errorName: error instanceof Error ? error.name : typeof error };
};

/**
 * The bound manga of a request when its chapters may be offered: manga is
 * enabled, the manifest is bound, its Suwayomi server is still configured and
 * serves CBZ archives, and the title's source match is still active.
 */
const loadContext = async (requestId: number) => {
  if (!isMediaCategoryEnabled('manga')) return undefined;
  const manifest = await getRepository(MangaRequestManifest).findOne({
    where: { requestId },
  });
  if (
    !manifest ||
    manifest.bindingState !== MangaRequestBindingState.BOUND ||
    manifest.bindingSourceId === null ||
    manifest.bindingUrlHash === null
  ) {
    return undefined;
  }
  const instance = getExternalRuntimeConfig().suwayomi.find(
    (entry) => entry.id === manifest.instanceId
  );
  if (instance?.requireCbz !== true) return undefined;
  const binding = await getRepository(MangaSourceBinding).findOne({
    where: {
      instanceId: manifest.instanceId,
      sourceId: manifest.bindingSourceId,
      urlHash: manifest.bindingUrlHash,
      anilistId: manifest.anilistId,
      state: MangaBindingState.ACTIVE,
    },
  });
  if (!binding) return undefined;
  return {
    manifestId: manifest.id,
    anilistId: manifest.anilistId,
    instanceId: manifest.instanceId,
    manga: {
      sourceId: manifest.bindingSourceId,
      url: binding.url,
      urlHash: manifest.bindingUrlHash,
    },
  };
};

const cleanTitle = (value: string): string =>
  value
    // Control characters and unpaired surrogates, which no file name holds.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\ud800-\udfff]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX_LENGTH)
    // The cut must not keep half of a character: its file name would fail to
    // encode.
    .replace(/[\ud800-\udbff]$/, '')
    .trim();

/** The title the request list shows, from the cached AniList client. */
const loadTitle = async (anilistId: number): Promise<string> => {
  const fallback = `Manga ${anilistId}`;
  try {
    const manga = await new AnilistAPI({
      maxRateLimitWaitMs: TITLE_RATE_LIMIT_WAIT_MS,
    }).getMangaDetails(anilistId);
    if (!manga || isAnilistMangaExcluded(manga, getMangaContentPolicy())) {
      return fallback;
    }
    const { english, romaji, native } = manga.titles;
    return cleanTitle(english ?? romaji ?? native ?? '') || fallback;
  } catch {
    return fallback;
  }
};

const numberOf = ({
  chapterNumber,
}: Pick<MangaRequestChapter, 'chapterNumber'>) =>
  isKnownMangaChapterNumber(chapterNumber) ? chapterNumber : undefined;

/**
 * Every chapter of the request's own manifest that the progress poll
 * verified and still finds, newest first with unknown numbers last. Never
 * contacts Suwayomi; names are unique within the request.
 */
export const loadMangaDownloadCopies = async (
  request: Pick<MediaRequest, 'id'>
): Promise<MangaDownloadCopy[]> => {
  const context = await loadContext(request.id);
  if (!context) return [];
  const rows = await getRepository(MangaRequestChapter).find({
    select: { id: true, urlHash: true, chapterNumber: true },
    where: {
      manifestId: context.manifestId,
      deliverableAt: Not(IsNull()),
      missingSince: IsNull(),
    },
    order: { id: 'ASC' },
  });
  if (rows.length === 0) return [];

  const title = await loadTitle(context.anilistId);
  const sorted = rows.sort(
    (a, b) => (numberOf(b) ?? -1) - (numberOf(a) ?? -1) || a.id - b.id
  );
  const seen = new Map<string, number>();
  return sorted.map((row) => {
    const label = String(numberOf(row) ?? 'unknown');
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return {
      name: `${title} - Ch. ${label}${count > 1 ? ` (${count})` : ''}.cbz`,
      instanceId: context.instanceId,
      manifestId: context.manifestId,
      urlHash: row.urlHash,
      manga: context.manga,
    };
  });
};

/**
 * Opens a chapter's CBZ on Suwayomi. The manga is resolved by its natural
 * key on every open, since a backup restore can renumber Suwayomi's IDs, and
 * the chapter must be a downloaded chapter of that manga. Writes nothing.
 * Undefined when Suwayomi no longer has the manga or the chapter.
 */
export const openMangaDownloadCopy = async (
  copy: MangaDownloadCopy,
  signal: AbortSignal
): Promise<SuwayomiByteStream | undefined> => {
  const client = getSuwayomiClient(copy.instanceId);
  if (!client) return undefined;
  const options = { signal };
  const found = await client.findMangaByNaturalKey(
    copy.manga.sourceId,
    copy.manga.url,
    options
  );
  if (
    !found ||
    found.sourceId !== copy.manga.sourceId ||
    hashMangaSourceUrl(found.url) !== copy.manga.urlHash
  ) {
    return undefined;
  }
  const chapter = (await client.getDownloadedChapters(found.id, options)).find(
    (entry) =>
      entry.mangaId === found.id &&
      entry.isDownloaded &&
      hashMangaSourceUrl(entry.url) === copy.urlHash
  );
  return chapter ? client.streamChapterArchive(chapter.id, options) : undefined;
};

const streamsByUser = new Map<number, number>();
const streamsByInstance = new Map<number, number>();

const adjust = (counts: Map<number, number>, key: number, delta: number) => {
  const next = (counts.get(key) ?? 0) + delta;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
};

/**
 * Takes a download slot for a user on a Suwayomi server, or returns
 * undefined when either is at its limit. The returned release frees the
 * slot once, however often it is called.
 */
export const acquireMangaDownloadSlot = (
  userId: number,
  instanceId: number
): (() => void) | undefined => {
  if (
    (streamsByUser.get(userId) ?? 0) >= MANGA_DOWNLOAD_STREAMS_PER_USER ||
    (streamsByInstance.get(instanceId) ?? 0) >=
      MANGA_DOWNLOAD_STREAMS_PER_INSTANCE
  ) {
    return undefined;
  }
  adjust(streamsByUser, userId, 1);
  adjust(streamsByInstance, instanceId, 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    adjust(streamsByUser, userId, -1);
    adjust(streamsByInstance, instanceId, -1);
  };
};

/** Slots in use, summed over users and over servers. */
export const countMangaDownloadSlots = (): {
  users: number;
  instances: number;
} => {
  const sum = (counts: Map<number, number>) =>
    [...counts.values()].reduce((total, value) => total + value, 0);
  return { users: sum(streamsByUser), instances: sum(streamsByInstance) };
};

/** The guard of one running download. */
export interface MangaDownloadGuard {
  /** Stops both timers; the guard then never fires. */
  dispose: () => void;
  /** The limit that stopped the download, once one has. */
  readonly stopped: MangaDownloadLimitError | undefined;
}

/**
 * Stops a download once nothing flows for `stallMs` (the client accepts no
 * bytes) or once `totalMs` has passed. It destroys `source`, which aborts the
 * Suwayomi request, and `target`, which may still hold the archive's last
 * bytes for a client that stopped reading after Suwayomi finished sending.
 * Install it in the same tick as the pipeline from `source` to `target`.
 */
export const guardMangaDownload = (
  source: Readable,
  target: Pick<Writable, 'destroy' | 'writableFinished'>,
  {
    stallMs = MANGA_DOWNLOAD_STALL_MS,
    totalMs = MANGA_DOWNLOAD_TOTAL_MS,
  }: { stallMs?: number; totalMs?: number } = {}
): MangaDownloadGuard => {
  let done = false;
  let stopped: MangaDownloadLimitError | undefined;
  // A timer from an earlier generation does nothing when it fires, so the
  // guard holds even where clearing a timer has no effect.
  let generation = 0;
  const timers: { stall?: NodeJS.Timeout; total?: NodeJS.Timeout } = {};
  const dispose = () => {
    done = true;
    generation += 1;
    clearTimeout(timers.stall);
    clearTimeout(timers.total);
  };
  const stop = (code: 'STALLED' | 'TOTAL_TIME') => {
    if (done) return;
    dispose();
    // A finished response already handed every byte to the network.
    if (target.writableFinished) return;
    stopped = new MangaDownloadLimitError(code);
    source.destroy(stopped);
    target.destroy();
  };
  const arm = () => {
    if (done) return;
    clearTimeout(timers.stall);
    const armed = ++generation;
    timers.stall = setTimeout(() => {
      if (armed === generation) stop('STALLED');
    }, stallMs);
  };
  timers.total = setTimeout(() => stop('TOTAL_TIME'), totalMs);
  source.on('data', arm);
  arm();
  return {
    dispose: () => {
      dispose();
      source.off('data', arm);
    },
    get stopped() {
      return stopped;
    },
  };
};

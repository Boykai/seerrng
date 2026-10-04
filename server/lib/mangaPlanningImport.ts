import type AnilistAPI from '@server/api/anilist';
import {
  AnilistAuthError,
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist/failures';
import {
  isAnilistMangaExcluded,
  type AnilistMangaPlanningEntry,
} from '@server/api/anilist/manga';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import DiscoveryAccount from '@server/entity/DiscoveryAccount';
import { User } from '@server/entity/User';
import {
  DuplicateWatchlistRequestError,
  NotFoundError,
  Watchlist,
} from '@server/entity/Watchlist';
import {
  DiscoveryIntegrationError,
  getAnilistClient,
} from '@server/lib/discoveryIntegrations/accounts';
import { getMangaContentPolicy } from '@server/lib/mangaCatalog';
import { findMangaMedia } from '@server/lib/mangaMedia';
import {
  MangaCatalogUnavailableError,
  MangaRequestNotFoundError,
} from '@server/lib/mangaRequests';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import logger from '@server/logger';
import { getHttpErrorDetails } from '@server/utils/httpError';
import { In } from 'typeorm';

const LABEL = 'AniList Planning Import';

/** AniList calls one run may make: list pages, viewer lookups and adds. */
export const PLANNING_IMPORT_RUN_BUDGET = 15;
/** List pages of 50 read per user and run: the 200 newest changes. */
export const PLANNING_IMPORT_MAX_PAGES = 4;
/** Watchlist adds attempted per user and run. */
export const PLANNING_IMPORT_MAX_ADDS = 10;

export interface PlanningImportCounts {
  users: number;
  added: number;
  skipped: number;
}

interface Run {
  budget: number;
  signal?: AbortSignal;
  counts: PlanningImportCounts;
}

/**
 * How a user's turn ended. A deferred user goes first in the next run: the
 * run budget or AniList stopped the turn before it was complete.
 */
type Turn = 'done' | 'deferred';

/** The AniList failure behind a catalog lookup error. */
const unwrap = (error: unknown): unknown =>
  error instanceof MangaCatalogUnavailableError ? error.failure : error;

const errorDetails = (error: unknown): Record<string, unknown> => ({
  errorName: error instanceof Error ? error.name : typeof error,
  ...getHttpErrorDetails(error),
});

/**
 * AniList cannot answer anyone right now. Any other failure concerns one
 * user or title, so it must not hold up the rest of the run.
 */
const isAnilistUnavailable = (error: unknown): boolean => {
  const failure = unwrap(error);
  return (
    failure instanceof AnilistRateLimitedError ||
    failure instanceof AnilistOutageError
  );
};

const logAnilistUnavailable = (error: unknown): void => {
  logger.info('AniList is unavailable; the import continues next run', {
    label: LABEL,
    errorName: (unwrap(error) as Error).name,
  });
};

const parseAnilistUserId = (value: string): number | undefined => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647
    ? id
    : undefined;
};

type Cursor = { updatedAt: number; anilistId: number };

/** The list query's order, reversed: by change time, then by AniList ID. */
const compareEntries = (left: Cursor, right: Cursor): number =>
  left.updatedAt - right.updatedAt || left.anilistId - right.anilistId;

/**
 * The user's Planning entries after `cursor`, the last entry handled, newest
 * first, up to the page cap. Undefined when the run budget ran out before the
 * read ended.
 */
const readPlanning = async (
  client: AnilistAPI,
  anilistUserId: number,
  cursor: Cursor,
  run: Run
): Promise<AnilistMangaPlanningEntry[] | undefined> => {
  const entries = new Map<number, AnilistMangaPlanningEntry>();
  for (let page = 1; page <= PLANNING_IMPORT_MAX_PAGES; page++) {
    if (run.budget < 1) return undefined;
    run.budget -= 1;
    const result = await client.getMangaPlanningPage(anilistUserId, page, {
      signal: run.signal,
    });
    for (const entry of result.entries) {
      if (compareEntries(entry, cursor) <= 0) return [...entries.values()];
      // A list that changes while it is read can repeat an entry.
      if (!entries.has(entry.anilistId)) entries.set(entry.anilistId, entry);
    }
    if (!result.hasNextPage) break;
  }
  return [...entries.values()];
};

/** Titles the import leaves alone without asking AniList about them. */
const findSkippedTitles = async (
  userId: number,
  anilistIds: number[]
): Promise<Set<number>> => {
  const values = anilistIds.map(String);
  const [watchlisted, blocklisted, media] = await Promise.all([
    getRepository(Watchlist).find({
      select: { id: true, externalId: true },
      where: {
        mediaType: MediaType.MANGA,
        externalId: In(values),
        requestedBy: { id: userId },
      },
      loadEagerRelations: false,
    }),
    getRepository(Blocklist).find({
      select: { id: true, externalId: true },
      where: { mediaType: MediaType.MANGA, externalId: In(values) },
      loadEagerRelations: false,
    }),
    findMangaMedia(dataSource.manager, anilistIds),
  ]);
  const skipped = new Set(
    [...watchlisted, ...blocklisted].map(({ externalId }) => Number(externalId))
  );
  for (const [anilistId, found] of media) {
    // Null: the AniList ID belongs to media of another type.
    if (found === null || found.status === MediaStatus.BLOCKLISTED) {
      skipped.add(anilistId);
    }
  }
  return skipped;
};

/**
 * Adds a user's new Planning manga to their watchlist through the normal
 * watchlist path, so validation and the auto-request rule apply as for an
 * add in the app. Reads only; nothing is written to AniList.
 */
const importUser = async (accountId: number, run: Run): Promise<Turn> => {
  // Read when the turn begins: since the run began, the user may have turned
  // the import off or reconnected AniList.
  const account = await getRepository(DiscoveryAccount).findOneBy({
    id: accountId,
    importMangaPlanning: true,
  });
  if (!account) return 'done';
  const { userId } = account;
  let client: AnilistAPI;
  let read: AnilistMangaPlanningEntry[] | undefined;
  try {
    client = await getAnilistClient(userId);
    let anilistUserId = parseAnilistUserId(account.providerUserId);
    if (anilistUserId === undefined) {
      run.budget -= 1;
      anilistUserId = (await client.getViewer()).id;
    }
    // Without a cursor, every entry comes after it.
    read = await readPlanning(
      client,
      anilistUserId,
      {
        updatedAt: account.mangaPlanningCursor ?? -1,
        anilistId: account.mangaPlanningCursorId ?? 0,
      },
      run
    );
  } catch (error) {
    if (run.signal?.aborted) throw error;
    if (isAnilistUnavailable(error)) {
      logAnilistUnavailable(error);
      return 'deferred';
    }
    if (
      error instanceof DiscoveryIntegrationError ||
      error instanceof AnilistAuthError
    ) {
      logger.debug('Skipping a user whose AniList link is unusable', {
        label: LABEL,
        userId,
      });
    } else {
      logger.warn('Could not read a Planning list', {
        label: LABEL,
        userId,
        ...errorDetails(error),
      });
    }
    return 'done';
  }
  if (read === undefined) return 'deferred';
  run.counts.users += 1;

  const entries = read.sort(compareEntries);
  const user = await getRepository(User).findOneBy({ id: userId });
  if (!entries.length || !user) return 'done';
  const skipped = await findSkippedTitles(
    userId,
    entries.map(({ anilistId }) => anilistId)
  );
  const policy = getMangaContentPolicy();

  let processed = 0;
  let adds = 0;
  let turn: Turn = 'done';
  for (const entry of entries) {
    if (run.signal?.aborted) {
      turn = 'deferred';
      break;
    }
    if (skipped.has(entry.anilistId) || isAnilistMangaExcluded(entry, policy)) {
      run.counts.skipped += 1;
      processed += 1;
      continue;
    }
    if (adds >= PLANNING_IMPORT_MAX_ADDS) break;
    if (run.budget < 1) {
      turn = 'deferred';
      break;
    }
    adds += 1;
    run.budget -= 1;
    try {
      await Watchlist.createWatchlist({
        watchlistRequest: {
          mediaType: MediaType.MANGA,
          externalId: String(entry.anilistId),
        },
        user,
      });
      run.counts.added += 1;
    } catch (error) {
      if (
        error instanceof DuplicateWatchlistRequestError ||
        error instanceof MangaRequestNotFoundError
      ) {
        run.counts.skipped += 1;
      } else if (isAnilistUnavailable(error)) {
        logAnilistUnavailable(error);
        turn = 'deferred';
        break;
      } else if (error instanceof NotFoundError) {
        // Manga were turned off during the run.
        turn = 'deferred';
        break;
      } else {
        // The title is retried next run; the next user goes on now.
        logger.warn('Could not add a Planning manga to a watchlist', {
          label: LABEL,
          userId,
          anilistId: entry.anilistId,
          ...errorDetails(unwrap(error)),
        });
        break;
      }
    }
    processed += 1;
  }

  if (processed > 0) {
    // Handled up to here. Not after a relink, which turns the import off and
    // resets the cursor, or once the account is linked to another AniList user.
    await getRepository(DiscoveryAccount).update(
      {
        id: account.id,
        importMangaPlanning: true,
        providerUserId: account.providerUserId,
      },
      {
        mangaPlanningCursor: entries[processed - 1].updatedAt,
        mangaPlanningCursorId: entries[processed - 1].anilistId,
      }
    );
  }
  return turn;
};

/**
 * One bounded import pass over the opted-in AniList accounts, starting after
 * `rotation.lastUserId` so that the run budget reaches every user in turn.
 */
export const runMangaPlanningImport = async (
  rotation: { lastUserId: number },
  options: { signal?: AbortSignal } = {}
): Promise<PlanningImportCounts> => {
  const run: Run = {
    budget: PLANNING_IMPORT_RUN_BUDGET,
    signal: options.signal,
    counts: { users: 0, added: 0, skipped: 0 },
  };
  if (!isMediaCategoryEnabled('manga')) return run.counts;
  const accounts = await getRepository(DiscoveryAccount).find({
    select: { id: true, userId: true },
    where: { provider: 'anilist', importMangaPlanning: true },
    order: { userId: 'ASC' },
  });
  const ordered = [
    ...accounts.filter(({ userId }) => userId > rotation.lastUserId),
    ...accounts.filter(({ userId }) => userId <= rotation.lastUserId),
  ];
  for (const { id, userId } of ordered) {
    // A turn needs one list page and one add at least.
    if (run.signal?.aborted || run.budget < 2) break;
    if (!isMediaCategoryEnabled('manga')) break;
    if ((await importUser(id, run)) === 'deferred') break;
    rotation.lastUserId = userId;
  }
  return run.counts;
};

/** The scheduled job's runner: one run at a time, and cancellable. */
class MangaPlanningImporter {
  private controller?: AbortController;
  private readonly rotation = { lastUserId: 0 };

  public status(): { running: boolean } {
    return { running: this.controller !== undefined };
  }

  public cancel(): void {
    this.controller?.abort();
  }

  /** Never throws: the job runner would log a thrown error's message. */
  public async run(): Promise<void> {
    if (this.controller || !isMediaCategoryEnabled('manga')) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const counts = await runMangaPlanningImport(this.rotation, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        logger.info('AniList Planning import cancelled', { label: LABEL });
      } else {
        logger.debug('AniList Planning import finished', {
          label: LABEL,
          ...counts,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        logger.info('AniList Planning import cancelled', { label: LABEL });
      } else {
        logger.error('AniList Planning import failed', {
          label: LABEL,
          ...errorDetails(error),
        });
      }
    } finally {
      this.controller = undefined;
    }
  }
}

export const mangaPlanningImporter = new MangaPlanningImporter();

import AnilistAPI from '@server/api/anilist';
import {
  ANILIST_MANGA_BATCH_SIZE,
  isAnilistMangaExcluded,
  type AnilistMangaSummary,
} from '@server/api/anilist/manga';
import type SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import type { SuwayomiChapterNumbers } from '@server/api/suwayomi/types';
import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
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
import logger from '@server/logger';
import { chunk } from '@server/utils/chunk';
import { mapWithConcurrency } from '@server/utils/concurrency';
import { createHash } from 'node:crypto';
import { In, IsNull, Not } from 'typeorm';
import type { ReleaseCalendarItem } from './normalize';
import type { CalendarQuery } from './query';

export const MANGA_CALENDAR_LIMITS = {
  /** Suwayomi instances read; the rest are left out. */
  instances: 20,
  /** Requested titles, newest request first. */
  requests: 1_000,
  /** Unrequested library titles of each instance, with unmonitored titles. */
  libraryTitles: 1_000,
  /**
   * GraphQL calls for each instance and calendar load, the check for
   * earlier chapter versions included.
   */
  pages: 30,
  /** Titles named through AniList, earliest release first. */
  titles: 200,
  events: 5_000,
  /** Reduced rows each of the two caches holds across all its entries. */
  cacheRows: 50_000,
  /** Entries each of the two caches holds. */
  cacheEntries: 64,
};

export type MangaCalendarLimits = typeof MANGA_CALENDAR_LIMITS;

const MANGA_IDS_PER_READ = 100;
/** Chapter numbers asked in one check for earlier versions. */
const MANGA_CALENDAR_CHECK_NUMBERS = 500;
const MANGA_CALENDAR_LOOKUP_CHUNK = 500;
const MANGA_CALENDAR_CONCURRENCY = 3;
const MANGA_CALENDAR_DEADLINE_MS = 20_000;
const MANGA_CALENDAR_CACHE_TTL_MS = 60_000;
const ANILIST_RATE_LIMIT_WAIT_MS = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MangaCalendarOptions {
  now?: Date;
  /** Bounds below the defaults, for tests. */
  limits?: Partial<MangaCalendarLimits>;
  /** A monotonic clock in milliseconds, for tests. */
  clock?: () => number;
}

export type MangaCalendarResult = {
  results: ReleaseCalendarItem[];
  partialSources: { source: string; serverId?: number }[];
  truncated: boolean;
};

/** A bound source manga of a title on one instance. */
interface Target {
  anilistId: number;
  instanceId: number;
  sourceId: string;
  urlHash: string;
  /** Suwayomi IDs that may hold the source manga; each one is checked. */
  suwayomiIds: number[];
}

interface DayCount {
  count: number;
  /** Every counted chapter has a downloaded copy. */
  downloaded: boolean;
}

interface NumberedChapter {
  /** The number's earliest release day within the window read. */
  day: string;
  downloaded: boolean;
}

/** The chapters of one instance read, reduced to what the calendar shows. */
interface InstanceReleases {
  keys: Map<number, { sourceId: string; urlHash?: string }>;
  known: Map<number, Map<number, NumberedChapter>>;
  unknown: Map<number, Map<string, DayCount>>;
  truncated: boolean;
  /** GraphQL calls the read made. */
  pages: number;
  /** How long the read took, by the calendar's clock. */
  elapsedMs: number;
  size: number;
}

/** The asked chapter numbers an instance already released before a window. */
interface EarlierReleases {
  found: { mangaId: number; chapterNumber: number }[];
  truncated: boolean;
  size: number;
}

interface CacheEntry<T> {
  expiresAt: number;
  size: number;
  value: Promise<T>;
  /** The time a read still running was given. */
  ms?: number;
}

/**
 * Results shared while they are fresh and within the row and entry bounds;
 * a failed read is never kept. A read still running is shared only with
 * callers that have no more time than it was given; any other caller starts
 * its own read, which later callers share.
 */
const createCache = <T extends { size: number }>() => {
  const entries = new Map<string, CacheEntry<T>>();
  let rows = 0;

  const drop = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    rows -= entry.size;
  };

  const evict = (limits: MangaCalendarLimits, keep: string): void => {
    for (const key of entries.keys()) {
      if (entries.size <= limits.cacheEntries && rows <= limits.cacheRows)
        return;
      if (key !== keep) drop(key);
    }
  };

  return {
    reset(): void {
      entries.clear();
      rows = 0;
    },
    load(
      key: string,
      now: number,
      limits: MangaCalendarLimits,
      read: () => Promise<T>,
      ms = 0
    ): Promise<T> {
      for (const [cachedKey, entry] of entries)
        if (entry.expiresAt <= now) drop(cachedKey);
      const hit = entries.get(key);
      if (hit && (hit.ms ?? ms) >= ms) return hit.value;
      drop(key);
      const entry: CacheEntry<T> = {
        expiresAt: now + MANGA_CALENDAR_CACHE_TTL_MS,
        size: 0,
        value: read(),
        ms,
      };
      entries.set(key, entry);
      evict(limits, key);
      entry.value.then(
        (value) => {
          if (entries.get(key) !== entry) return;
          delete entry.ms;
          if (value.size > limits.cacheRows) {
            entries.delete(key);
            return;
          }
          entry.size = value.size;
          rows += value.size;
          evict(limits, key);
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        }
      );
      return entry.value;
    },
  };
};

const releaseCache = createCache<InstanceReleases>();
const earlierCache = createCache<EarlierReleases>();
const clientKeys = new WeakMap<SuwayomiAPI, number>();
let nextClientKey = 0;

/** Empties the chapter release caches. */
export const resetMangaReleaseCalendarCache = (): void => {
  releaseCache.reset();
  earlierCache.reset();
};

// A changed address or login gets a new client, so its reads never reuse
// what another server returned.
const clientKey = (client: SuwayomiAPI): number => {
  let key = clientKeys.get(client);
  if (key === undefined) {
    nextClientKey += 1;
    key = nextClientKey;
    clientKeys.set(client, key);
  }
  return key;
};

const utcDay = (time: number): string =>
  new Date(time).toISOString().slice(0, 10);

const hashOf = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const readInstance = async (
  client: SuwayomiAPI,
  ids: number[],
  window: { from: Date; before: Date },
  now: number,
  limits: MangaCalendarLimits,
  clock: () => number
): Promise<InstanceReleases> => {
  const started = clock();
  const releases: InstanceReleases = {
    keys: new Map(),
    known: new Map(),
    unknown: new Map(),
    truncated: false,
    pages: 0,
    elapsedMs: 0,
    size: 0,
  };
  const signal = AbortSignal.timeout(MANGA_CALENDAR_DEADLINE_MS);
  for (const slice of chunk(ids, MANGA_IDS_PER_READ)) {
    if (releases.pages >= limits.pages) {
      releases.truncated = true;
      break;
    }
    const read = await client.getChapterReleases(
      slice.map(String),
      window,
      limits.pages - releases.pages,
      { signal }
    );
    releases.pages += read.pages;
    const requested = new Set(slice);
    for (const manga of read.mangas) {
      const id = Number(manga.id);
      if (!requested.has(id)) continue;
      releases.keys.set(id, {
        sourceId: manga.sourceId,
        urlHash: manga.url ? hashMangaSourceUrl(manga.url) : undefined,
      });
    }
    for (const chapter of read.chapters) {
      const mangaId = Number(chapter.mangaId);
      if (!requested.has(mangaId) || chapter.releasedAt > now) continue;
      const day = utcDay(chapter.releasedAt);
      if (isKnownMangaChapterNumber(chapter.chapterNumber)) {
        const numbers =
          releases.known.get(mangaId) ?? new Map<number, NumberedChapter>();
        releases.known.set(mangaId, numbers);
        const current = numbers.get(chapter.chapterNumber);
        numbers.set(chapter.chapterNumber, {
          day: current && current.day < day ? current.day : day,
          downloaded: (current?.downloaded ?? false) || chapter.isDownloaded,
        });
      } else {
        const days =
          releases.unknown.get(mangaId) ?? new Map<string, DayCount>();
        releases.unknown.set(mangaId, days);
        const current = days.get(day);
        days.set(day, {
          count: (current?.count ?? 0) + 1,
          downloaded: (current?.downloaded ?? true) && chapter.isDownloaded,
        });
      }
    }
    if (!read.complete) {
      releases.truncated = true;
      break;
    }
  }
  releases.size = releases.keys.size;
  for (const numbers of releases.known.values()) releases.size += numbers.size;
  for (const days of releases.unknown.values()) releases.size += days.size;
  releases.elapsedMs = Math.ceil(clock() - started);
  return releases;
};

/** One read per instance, window and title set, shared while it is fresh. */
const loadInstance = (
  client: SuwayomiAPI,
  instanceId: number,
  ids: number[],
  window: { from: Date; before: Date },
  now: number,
  limits: MangaCalendarLimits,
  clock: () => number
): Promise<InstanceReleases> =>
  releaseCache.load(
    JSON.stringify([
      clientKey(client),
      instanceId,
      window.from.getTime(),
      window.before.getTime(),
      hashOf(ids.join(',')),
    ]),
    now,
    limits,
    () => readInstance(client, ids, window, now, limits, clock)
  );

/** Asks of each manga at most 100 manga and 500 numbers a call. */
const checkBatches = (
  numbers: [number, number[]][]
): SuwayomiChapterNumbers[][] => {
  const batches: SuwayomiChapterNumbers[][] = [];
  let batch: SuwayomiChapterNumbers[] = [];
  let asked = 0;
  for (const [mangaId, chapterNumbers] of numbers) {
    for (let next = 0; next < chapterNumbers.length;) {
      if (
        batch.length === MANGA_IDS_PER_READ ||
        asked === MANGA_CALENDAR_CHECK_NUMBERS
      ) {
        batches.push(batch);
        batch = [];
        asked = 0;
      }
      const slice = chapterNumbers.slice(
        next,
        next + MANGA_CALENDAR_CHECK_NUMBERS - asked
      );
      batch.push({ mangaId: String(mangaId), chapterNumbers: slice });
      asked += slice.length;
      next += slice.length;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
};

/**
 * Which of the numbers asked of each manga already had a version released
 * before `before`, within the pages and time the instance's read left.
 * Running out of time throws, so nothing of a late check is used.
 */
const checkInstance = async (
  client: SuwayomiAPI,
  numbers: [number, number[]][],
  before: Date,
  budget: { pages: number; ms: number },
  clock: () => number
): Promise<EarlierReleases> => {
  const started = clock();
  const outOfTime = () => {
    if (clock() - started >= budget.ms)
      throw new SuwayomiError('TIMEOUT', 'EarlierChapterReleases');
  };
  outOfTime();
  const signal = AbortSignal.timeout(budget.ms);
  const earlier: EarlierReleases = { found: [], truncated: false, size: 0 };
  let pages = 0;
  for (const batch of checkBatches(numbers)) {
    if (pages >= budget.pages) {
      earlier.truncated = true;
      break;
    }
    outOfTime();
    const read = await client.getEarlierChapterReleases(
      batch,
      before,
      budget.pages - pages,
      { signal }
    );
    pages += read.pages;
    for (const { mangaId, chapterNumber } of read.found)
      earlier.found.push({ mangaId: Number(mangaId), chapterNumber });
    if (!read.complete) {
      earlier.truncated = true;
      break;
    }
  }
  outOfTime();
  earlier.size = earlier.found.length;
  return earlier;
};

/** Fails with TIMEOUT when the check takes longer than `ms`. */
const within = <T>(check: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    check,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SuwayomiError('TIMEOUT', 'EarlierChapterReleases')),
        Math.max(ms, 0)
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * One check per instance, window start, query budget and numbers while fresh.
 * A load waits for a check another load started no longer than its own time.
 */
const loadEarlier = (
  client: SuwayomiAPI,
  instanceId: number,
  numbers: [number, number[]][],
  before: Date,
  budget: { pages: number; ms: number },
  now: number,
  limits: MangaCalendarLimits,
  clock: () => number
): Promise<EarlierReleases> =>
  within(
    earlierCache.load(
      JSON.stringify([
        clientKey(client),
        instanceId,
        before.getTime(),
        budget.pages,
        hashOf(JSON.stringify(numbers)),
      ]),
      now,
      limits,
      () => checkInstance(client, numbers, before, budget, clock),
      budget.ms
    ),
    budget.ms
  );

const targetKey = (
  target: Pick<Target, 'anilistId' | 'instanceId' | 'sourceId' | 'urlHash'>
) =>
  JSON.stringify([
    target.instanceId,
    target.sourceId,
    target.urlHash,
    target.anilistId,
  ]);

/** The requests' titles whose manifest is bound to an active source match. */
const boundTargets = async (
  manifests: MangaRequestManifest[]
): Promise<Target[]> => {
  const bound = manifests.filter(
    (manifest) =>
      manifest.bindingState === MangaRequestBindingState.BOUND &&
      manifest.bindingSourceId !== null &&
      manifest.bindingUrlHash !== null
  );
  const bindings = new Map<string, MangaSourceBinding>();
  for (const hashes of chunk(
    [...new Set(bound.map((manifest) => manifest.bindingUrlHash as string))],
    MANGA_CALENDAR_LOOKUP_CHUNK
  ))
    for (const binding of await getRepository(MangaSourceBinding).find({
      where: { urlHash: In(hashes), state: MangaBindingState.ACTIVE },
    }))
      bindings.set(targetKey(binding), binding);
  return bound.flatMap((manifest) => {
    const binding = bindings.get(
      targetKey({
        anilistId: manifest.anilistId,
        instanceId: manifest.instanceId,
        sourceId: manifest.bindingSourceId as string,
        urlHash: manifest.bindingUrlHash as string,
      })
    );
    if (!binding) return [];
    return [
      {
        anilistId: binding.anilistId,
        instanceId: binding.instanceId,
        sourceId: binding.sourceId,
        urlHash: binding.urlHash,
        suwayomiIds: [manifest.suwayomiMangaId, binding.suwayomiMangaId].filter(
          (id): id is number => id !== null
        ),
      },
    ];
  });
};

const requestedManifests = async (
  query: CalendarQuery,
  requests: MediaRequest[],
  limits: MangaCalendarLimits,
  result: MangaCalendarResult
): Promise<MangaRequestManifest[]> => {
  if (query.scope === 'all') {
    const manifests = await getRepository(MangaRequestManifest)
      .createQueryBuilder('manifest')
      .innerJoin('manifest.request', 'request')
      .where('request.status != :declined', {
        declined: MediaRequestStatus.DECLINED,
      })
      .andWhere('manifest.bindingState = :bound', {
        bound: MangaRequestBindingState.BOUND,
      })
      .orderBy('manifest.requestId', 'DESC')
      .limit(limits.requests + 1)
      .getMany();
    if (manifests.length > limits.requests) result.truncated = true;
    return manifests.slice(0, limits.requests);
  }
  const requestIds = requests
    .filter(
      (request) =>
        request.status !== MediaRequestStatus.DECLINED &&
        request.media?.mediaType === MediaType.MANGA
    )
    .map((request) => request.id);
  if (requestIds.length > limits.requests) result.truncated = true;
  const manifests: MangaRequestManifest[] = [];
  for (const ids of chunk(
    requestIds.slice(0, limits.requests),
    MANGA_CALENDAR_LOOKUP_CHUNK
  ))
    manifests.push(
      ...(await getRepository(MangaRequestManifest).findBy({
        requestId: In(ids),
      }))
    );
  return manifests;
};

/** The instance's bound library titles, requested or not. */
const libraryTargets = async (
  instanceId: number,
  limits: MangaCalendarLimits,
  result: MangaCalendarResult
): Promise<Target[]> => {
  const bindings = await getRepository(MangaSourceBinding).find({
    where: {
      instanceId,
      state: MangaBindingState.ACTIVE,
      inLibrary: true,
      suwayomiMangaId: Not(IsNull()),
    },
    order: { id: 'ASC' },
    take: limits.libraryTitles + 1,
  });
  if (bindings.length > limits.libraryTitles) result.truncated = true;
  return bindings.slice(0, limits.libraryTitles).map((binding) => ({
    anilistId: binding.anilistId,
    instanceId: binding.instanceId,
    sourceId: binding.sourceId,
    urlHash: binding.urlHash,
    suwayomiIds: [binding.suwayomiMangaId as number],
  }));
};

const addDay = (
  days: Map<string, DayCount>,
  day: string,
  count: number,
  downloaded: boolean
) => {
  const current = days.get(day);
  days.set(day, {
    count: (current?.count ?? 0) + count,
    downloaded: (current?.downloaded ?? true) && downloaded,
  });
};

const failureFields = (error: unknown) =>
  error instanceof SuwayomiError
    ? { code: error.code }
    : { errorName: error instanceof Error ? error.name : typeof error };

/**
 * Manga chapters that bound titles already released, one all-day entry per
 * title and UTC day, named from AniList. A chapter's date is its source's
 * upload date or, without one, when Suwayomi stored it. Nothing is ever
 * scheduled ahead, and a failure only marks its source as partial.
 */
export async function getMangaReleaseCalendar(
  query: CalendarQuery,
  requests: MediaRequest[],
  isAdmin = false,
  options: MangaCalendarOptions = {}
): Promise<MangaCalendarResult> {
  const result: MangaCalendarResult = {
    results: [],
    partialSources: [],
    truncated: false,
  };
  if (
    (query.mediaType && query.mediaType !== 'manga') ||
    !isMediaCategoryEnabled('manga')
  )
    return result;
  const limits = { ...MANGA_CALENDAR_LIMITS, ...options.limits };
  const now = (options.now ?? new Date()).getTime();
  const nowDay = new Date(now);
  const from = Math.max(query.allDayStart.getTime(), 0);
  const before = Math.min(
    query.allDayEnd.getTime(),
    Date.UTC(
      nowDay.getUTCFullYear(),
      nowDay.getUTCMonth(),
      nowDay.getUTCDate()
    ) + DAY_MS
  );
  if (before <= from) return result;
  const window = { from: new Date(from), before: new Date(before) };
  const clock = options.clock ?? (() => performance.now());
  try {
    let instances = getExternalRuntimeConfig().suwayomi;
    if (!instances.length) return result;
    if (instances.length > limits.instances) {
      result.truncated = true;
      instances = instances.slice(0, limits.instances);
    }
    const configured = new Set(instances.map(({ id }) => id));
    const targets = new Map<string, Target>();
    const addTargets = (found: Target[]) => {
      for (const target of found) {
        if (!configured.has(target.instanceId)) continue;
        const key = targetKey(target);
        const existing = targets.get(key);
        targets.set(key, {
          ...target,
          suwayomiIds: [
            ...new Set([
              ...(existing?.suwayomiIds ?? []),
              ...target.suwayomiIds,
            ]),
          ],
        });
      }
    };
    addTargets(
      await boundTargets(
        await requestedManifests(query, requests, limits, result)
      )
    );
    if (query.scope === 'all' && query.includeUnmonitored)
      for (const { id } of instances)
        addTargets(await libraryTargets(id, limits, result));

    const byInstance = new Map<number, Map<number, Target[]>>();
    for (const target of targets.values()) {
      const ids =
        byInstance.get(target.instanceId) ?? new Map<number, Target[]>();
      byInstance.set(target.instanceId, ids);
      for (const id of target.suwayomiIds)
        ids.set(id, [...(ids.get(id) ?? []), target]);
    }

    const reads = await mapWithConcurrency(
      [...byInstance],
      MANGA_CALENDAR_CONCURRENCY,
      async ([instanceId, ids]) => {
        try {
          const client = getSuwayomiClient(instanceId);
          if (!client) throw new Error('The Suwayomi instance is unavailable.');
          return {
            instanceId,
            client,
            ids,
            releases: await loadInstance(
              client,
              instanceId,
              [...ids.keys()].sort((a, b) => a - b),
              window,
              now,
              limits,
              clock
            ),
          };
        } catch (error) {
          logger.debug('Manga chapter releases could not be read.', {
            label: 'Release Calendar',
            instanceId,
            ...failureFields(error),
          });
          result.partialSources.push({
            source: 'suwayomi',
            ...(isAdmin ? { serverId: instanceId } : {}),
          });
          return undefined;
        }
      }
    );

    const titles = new Map<
      number,
      { known: Map<number, NumberedChapter>; unknown: Map<string, DayCount> }
    >();
    const merged = new Set<string>();
    // Each instance's matched manga and the titles bound to them.
    const matched = new Map<number, Map<number, Set<number>>>();
    for (const read of reads) {
      if (!read) continue;
      const { instanceId, ids, releases } = read;
      result.truncated ||= releases.truncated;
      for (const [suwayomiId, idTargets] of ids) {
        const key = releases.keys.get(suwayomiId);
        for (const target of idTargets) {
          if (
            key?.sourceId !== target.sourceId ||
            key.urlHash !== target.urlHash
          ) {
            logger.debug(
              'A bound manga no longer matches its Suwayomi entry; its chapter releases are skipped.',
              {
                label: 'Release Calendar',
                instanceId,
                suwayomiMangaId: suwayomiId,
              }
            );
            continue;
          }
          const source = JSON.stringify([
            target.anilistId,
            instanceId,
            suwayomiId,
          ]);
          if (merged.has(source)) continue;
          merged.add(source);
          const mangas =
            matched.get(instanceId) ?? new Map<number, Set<number>>();
          matched.set(instanceId, mangas);
          mangas.set(
            suwayomiId,
            (mangas.get(suwayomiId) ?? new Set<number>()).add(target.anilistId)
          );
          const title = titles.get(target.anilistId) ?? {
            known: new Map(),
            unknown: new Map(),
          };
          titles.set(target.anilistId, title);
          for (const [number, chapter] of releases.known.get(suwayomiId) ??
            []) {
            const current = title.known.get(number);
            title.known.set(number, {
              day:
                current && current.day < chapter.day
                  ? current.day
                  : chapter.day,
              downloaded: (current?.downloaded ?? false) || chapter.downloaded,
            });
          }
          for (const [day, count] of releases.unknown.get(suwayomiId) ?? [])
            addDay(title.unknown, day, count.count, count.downloaded);
        }
      }
    }

    // A number counts only where no matched manga of its title, on any
    // instance, released a version of it before the window.
    const checks = await mapWithConcurrency(
      reads.filter((read) => read !== undefined),
      MANGA_CALENDAR_CONCURRENCY,
      async ({ instanceId, client, releases }) => {
        const mangas = matched.get(instanceId);
        if (!mangas || from <= 0) return undefined;
        const numbers: [number, number[]][] = [];
        for (const [suwayomiId, anilistIds] of [...mangas].sort(
          ([left], [right]) => left - right
        )) {
          const asked = new Set<number>();
          for (const anilistId of anilistIds)
            for (const number of titles.get(anilistId)?.known.keys() ?? [])
              asked.add(number);
          if (asked.size)
            numbers.push([suwayomiId, [...asked].sort((a, b) => a - b)]);
        }
        if (!numbers.length) return undefined;
        const pages = limits.pages - releases.pages;
        if (pages < 1) {
          result.truncated = true;
          return undefined;
        }
        try {
          return {
            mangas,
            earlier: await loadEarlier(
              client,
              instanceId,
              numbers,
              window.from,
              { pages, ms: MANGA_CALENDAR_DEADLINE_MS - releases.elapsedMs },
              now,
              limits,
              clock
            ),
          };
        } catch (error) {
          logger.debug('Earlier chapter versions could not be checked.', {
            label: 'Release Calendar',
            instanceId,
            ...failureFields(error),
          });
          result.partialSources.push({
            source: 'suwayomi',
            ...(isAdmin ? { serverId: instanceId } : {}),
          });
          return undefined;
        }
      }
    );
    for (const check of checks) {
      if (!check) continue;
      result.truncated ||= check.earlier.truncated;
      for (const { mangaId, chapterNumber } of check.earlier.found)
        for (const anilistId of check.mangas.get(mangaId) ?? [])
          titles.get(anilistId)?.known.delete(chapterNumber);
    }

    const days = new Map<number, Map<string, DayCount>>();
    for (const [anilistId, title] of titles) {
      const perDay = new Map<string, DayCount>();
      for (const { day, downloaded } of title.known.values())
        addDay(perDay, day, 1, downloaded);
      for (const [day, count] of title.unknown)
        addDay(perDay, day, count.count, count.downloaded);
      if (perDay.size) days.set(anilistId, perDay);
    }
    const ordered = [...days]
      .map(([anilistId, perDay]) => ({
        anilistId,
        first: [...perDay.keys()].sort()[0],
      }))
      .sort(
        (left, right) =>
          left.first.localeCompare(right.first) ||
          left.anilistId - right.anilistId
      )
      .map(({ anilistId }) => anilistId);
    if (ordered.length > limits.titles) result.truncated = true;

    const policy = getMangaContentPolicy();
    const anilist = new AnilistAPI({
      maxRateLimitWaitMs: ANILIST_RATE_LIMIT_WAIT_MS,
    });
    const visible = new Map<number, AnilistMangaSummary>();
    for (const batch of chunk(
      ordered.slice(0, limits.titles),
      ANILIST_MANGA_BATCH_SIZE
    )) {
      try {
        for (const manga of await anilist.getMangaSummariesByIds(batch))
          if (!isAnilistMangaExcluded(manga, policy))
            visible.set(manga.id, manga);
      } catch (error) {
        logger.debug(
          'Manga titles for the release calendar could not be read.',
          {
            label: 'Release Calendar',
            titles: batch.length,
            ...failureFields(error),
          }
        );
        result.partialSources.push({ source: 'anilist' });
      }
    }

    const entries = ordered
      .flatMap((anilistId) => {
        const manga = visible.get(anilistId);
        const perDay = days.get(anilistId);
        if (!manga || !perDay) return [];
        const { english, romaji, native } = manga.titles;
        return [...perDay].map(
          ([day, { count, downloaded }]): ReleaseCalendarItem => ({
            id: `suwayomi:manga:${anilistId}:${day}`,
            source: 'suwayomi',
            mediaType: 'manga',
            title: english ?? romaji ?? native ?? '',
            startsAt: `${day}T00:00:00.000Z`,
            dateType: 'chapter',
            allDay: true,
            mangaId: anilistId,
            chapterCount: count,
            available: downloaded,
            is4k: false,
          })
        );
      })
      .sort(
        (left, right) =>
          left.startsAt.localeCompare(right.startsAt) ||
          left.id.localeCompare(right.id)
      );
    if (entries.length > limits.events) result.truncated = true;
    result.results = entries.slice(0, limits.events);
  } catch (error) {
    logger.debug('The manga release calendar could not be loaded.', {
      label: 'Release Calendar',
      ...failureFields(error),
    });
    result.results = [];
    result.partialSources.push({ source: 'suwayomi' });
  }
  result.partialSources = [
    ...new Map(
      result.partialSources.map((source) => [
        `${source.source}:${source.serverId ?? ''}`,
        source,
      ])
    ).values(),
  ];
  return result;
}

import AnilistAPI, {
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist';
import {
  isAnilistMangaExcluded,
  type AnilistMangaDetails,
} from '@server/api/anilist/manga';
import MangaDexAPI, { MangaDexRateLimitedError } from '@server/api/mangadex';
import type SuwayomiAPI from '@server/api/suwayomi';
import {
  SuwayomiError,
  type SuwayomiErrorCode,
} from '@server/api/suwayomi/errors';
import type {
  SuwayomiMangaSummary,
  SuwayomiSearchPage,
  SuwayomiSource,
} from '@server/api/suwayomi/types';
import dataSource from '@server/datasource';
import {
  hashMangaSourceUrl,
  MANGA_MATCHED_BY_MANGADEX_LINK,
  MANGA_MATCHED_BY_TITLE,
  MangaBindingConfidence,
} from '@server/entity/MangaSourceBinding';
import MangaSourceCandidate from '@server/entity/MangaSourceCandidate';
import MangaSourceResolution, {
  MangaResolutionStatus,
} from '@server/entity/MangaSourceResolution';
import { runWithRequestAdmission } from '@server/entity/MediaRequest';
import type {
  MangaResolveFailure,
  MangaResolveReason,
} from '@server/interfaces/api/mangaResolveInterfaces';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { getMangaContentPolicy } from '@server/lib/mangaCatalog';
import { getMangaAdmissionKey } from '@server/lib/mangaMedia';
import { hasActiveMangaBinding } from '@server/lib/mangaRequestBindings';
import {
  catchUpMangaResolverTitle,
  writeMangaResolverBinding,
} from '@server/lib/mangaResolver/bind';
import { MangaResolveError } from '@server/lib/mangaResolver/errors';
import {
  languageRank,
  mangadexQueries,
  mangaResolverProfile,
  rateSourceMatch,
  scoreSourceManga,
  sourceQueries,
} from '@server/lib/mangaResolver/scoring';
import {
  findWaitingMangaTitles,
  isMangaTitleDue,
  isMangaTitleSearchable,
  loadMangaResolutions,
  resolutionKey,
  type WaitingMangaTitle,
} from '@server/lib/mangaResolver/titles';
import { MANGA_TITLE_MEDIUM_SCORE } from '@server/lib/mangaTitleMatch';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import { mangadexUuidOf } from '@server/lib/scanners/manga/suwayomi/matching';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import { snapshotSuwayomiInstance } from '@server/lib/suwayomi/instanceAdmission';
import logger from '@server/logger';
import { AsyncResource } from 'node:async_hooks';

const LABEL = 'Manga Source Resolve';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_INT32 = 2_147_483_647;
/** Waits after runs in a row that found nothing; then every 7 days. */
const NO_MATCH_DELAYS_MS = [HOUR_MS, 6 * HOUR_MS, DAY_MS];
const LONG_RETRY_MS = 7 * DAY_MS;
const SHORT_RETRY_MS = HOUR_MS;
const EXCLUDED_RECHECK_MS = DAY_MS;
/** In `TitleResult.attempts`: one more run that found nothing. */
const NEXT_ON_LADDER = -1;

export interface MangaResolverLimits {
  titlesPerRun: number;
  /** Suwayomi searches per instance and run, `id:` probes included. */
  searchesPerInstance: number;
  concurrency: number;
  searchTimeoutMs: number;
  probesPerTitle: number;
  /** A source that never answered an `id:` probe is probed again after this. */
  probeRecheckMs: number;
  fuzzySourcesPerTitle: number;
  queriesPerSource: number;
  candidatesPerTitle: number;
  mangadexQueries: number;
  ambiguousUuids: number;
}

export const MANGA_RESOLVER_LIMITS: Readonly<MangaResolverLimits> = {
  titlesPerRun: 20,
  searchesPerInstance: 60,
  concurrency: 3,
  searchTimeoutMs: 30_000,
  probesPerTitle: 5,
  probeRecheckMs: 7 * DAY_MS,
  fuzzySourcesPerTitle: 20,
  queriesPerSource: 2,
  candidatesPerTitle: 10,
  mangadexQueries: 3,
  ambiguousUuids: 3,
};

/** The wait after `attempts` runs in a row that found nothing. */
export const mangaNoMatchDelayMs = (attempts: number): number =>
  NO_MATCH_DELAYS_MS[attempts - 1] ?? LONG_RETRY_MS;

/** Suwayomi failures that end the run for the instance. */
const INSTANCE_FAILURES: ReadonlySet<SuwayomiErrorCode> = new Set([
  'UNREACHABLE',
  'REQUEST_REFUSED',
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'AUTH_MODE_UNSUPPORTED',
  'AUTH_MODE_MISMATCH',
  'UNSUPPORTED_SERVER',
  'ABORTED',
]);

export interface MangaResolverCounts {
  titles: number;
  bound: number;
  needsPick: number;
  noMatch: number;
  excluded: number;
  deferred: number;
  searches: number;
  searchFailures: number;
}

const emptyCounts = (): MangaResolverCounts => ({
  titles: 0,
  bound: 0,
  needsPick: 0,
  noMatch: 0,
  excluded: 0,
  deferred: 0,
  searches: 0,
  searchFailures: 0,
});

/** Ends the run for one instance. */
class InstanceFailure extends Error {
  constructor(readonly code: string) {
    super('The Suwayomi instance failed');
    this.name = 'InstanceFailure';
  }
}

/**
 * Every run starts in the async context of module load. "Run now" and the
 * picker's search start runs from inside an admin route's admission, and
 * that admission's database connection is released once the route answers.
 */
const runScope = new AsyncResource('MangaSourceResolve');

interface RankedSource extends SuwayomiSource {
  /** Position in the instance's allowlist. */
  rank: number;
}

interface Hit {
  source: RankedSource;
  manga: SuwayomiMangaSummary;
  suwayomiMangaId: number;
  title: string;
}

interface Found extends Hit {
  score: number;
  confidence: MangaSourceCandidate['confidence'];
  matchedBy: string;
}

interface RunState {
  signal: AbortSignal;
  counts: MangaResolverCounts;
  anilist: AnilistAPI;
  mangadex: MangaDexAPI;
}

interface InstanceRun {
  snapshot: SuwayomiSettings;
  client: SuwayomiAPI;
  sources?: RankedSource[];
  searches: number;
}

/** What a title's run decided. Undefined fields keep the stored value. */
interface TitleResult {
  status?: MangaResolutionStatus;
  reason?: MangaResolveReason | null;
  mangadexUuid?: string | null;
  attempts?: number;
  nextAttemptAt?: Date | null;
  lastError: MangaResolveFailure | null;
  /** Replaces the title's candidates when set. */
  candidates?: Found[];
  /** The run searched MangaDex or the sources. */
  searched?: boolean;
  /** The run answered an admin's search request. */
  answered: boolean;
}

type Next = 'continue' | 'stop-instance' | 'stop-run';

const hitKey = (hit: Hit) => `${hit.source.id}\n${hit.manga.url}`;

const toHit = (
  source: RankedSource,
  manga: SuwayomiMangaSummary
): Hit | undefined => {
  const suwayomiMangaId = Number(manga.id);
  if (
    manga.sourceId !== source.id ||
    !Number.isSafeInteger(suwayomiMangaId) ||
    suwayomiMangaId < 1 ||
    suwayomiMangaId > MAX_INT32
  ) {
    return undefined;
  }
  // Search titles are cut at 512 UTF-16 units, which can split a pair.
  const title = manga.title.replace(/[\uD800-\uDBFF]$/, '').trim();
  return { source, manga, suwayomiMangaId, title };
};

/** Runs `worker` over `items`, `limit` at a time; the first error aborts. */
const runPool = async <Item>(
  items: readonly Item[],
  limit: number,
  controller: AbortController,
  worker: (item: Item) => Promise<void>
): Promise<void> => {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const lane = async () => {
    while (!failed && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await worker(item);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          controller.abort();
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane)
  );
  if (failed) throw failure;
};

/**
 * Finds a Suwayomi source manga for each requested manga title that waits
 * for a binding. It binds by itself only through an exact MangaDex link that
 * an allowlisted source confirms; everything else waits for an admin. Its
 * only Suwayomi write is the source search, which stores what it finds.
 */
export class MangaSourceResolver {
  private controller?: AbortController;
  private readonly limits: MangaResolverLimits;
  private readonly now: () => number;
  /**
   * Per instance and source: whether an `id:` probe found its manga, and
   * when a source that never did may be probed again.
   */
  private readonly probes = new Map<
    string,
    { positive: boolean; recheckAt: number }
  >();

  constructor(
    options: { limits?: Partial<MangaResolverLimits>; now?: () => number } = {}
  ) {
    this.limits = { ...MANGA_RESOLVER_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  public status(): { running: boolean } {
    return { running: this.controller !== undefined };
  }

  /** Aborts every call in flight; nothing is written after a cancel. */
  public cancel(): void {
    this.controller?.abort();
  }

  /** Never throws: failures are logged as codes. */
  public run(): Promise<void> {
    return runScope.runInAsyncScope(() => this.runInScope());
  }

  private async runInScope(): Promise<void> {
    if (this.controller) return;
    if (!isMediaCategoryEnabled('manga')) return;
    const controller = new AbortController();
    this.controller = controller;
    const run: RunState = {
      signal: controller.signal,
      counts: emptyCounts(),
      anilist: new AnilistAPI(),
      mangadex: new MangaDexAPI(),
    };
    try {
      const instanceIds = getExternalRuntimeConfig()
        .suwayomi.map(({ id }) => id)
        .sort((a, b) => a - b);
      for (const instanceId of instanceIds) {
        if (run.signal.aborted) break;
        if ((await this.resolveInstance(run, instanceId)) === 'stop-run') {
          break;
        }
      }
      if (run.counts.titles > 0 || run.signal.aborted) {
        logger.info(
          run.signal.aborted
            ? 'Manga source resolve cancelled'
            : 'Manga source resolve complete',
          { label: LABEL, ...run.counts }
        );
      }
    } catch (error) {
      if (!run.signal.aborted) {
        logger.error('Manga source resolve interrupted', {
          label: LABEL,
          code: error instanceof Error ? error.name : 'UNKNOWN',
        });
      }
    } finally {
      this.controller = undefined;
    }
  }

  private async resolveInstance(
    run: RunState,
    instanceId: number
  ): Promise<Next> {
    const snapshot = snapshotSuwayomiInstance(instanceId);
    const client = snapshot && getSuwayomiClient(instanceId);
    if (!snapshot || !client) return 'continue';
    const now = new Date(this.now());
    const waiting = await findWaitingMangaTitles(dataSource.manager, {
      instanceId,
    });
    const rows = await loadMangaResolutions(dataSource.manager, waiting);
    const rowOf = (title: WaitingMangaTitle) =>
      rows.get(resolutionKey(instanceId, title.anilistId));
    const requestedAt = (title: WaitingMangaTitle) =>
      rowOf(title)?.searchRequestedAt?.getTime() ?? Infinity;
    const due = waiting
      .filter(
        (title) =>
          isMangaTitleSearchable(title, rowOf(title)) &&
          isMangaTitleDue(rowOf(title), now)
      )
      .sort(
        (a, b) => requestedAt(a) - requestedAt(b) || a.requestId - b.requestId
      );
    const instance: InstanceRun = { snapshot, client, searches: 0 };
    for (const title of due) {
      if (run.signal.aborted) return 'stop-run';
      if (run.counts.titles >= this.limits.titlesPerRun) return 'stop-run';
      const next = await this.resolveTitle(run, instance, title.anilistId);
      if (next !== 'continue') return next;
    }
    return 'continue';
  }

  /**
   * Keeps the title's status and backoff, so a failure elsewhere never makes
   * it wait longer; `retryMs` brings its next attempt closer.
   */
  private deferred(
    lastError: MangaResolveFailure,
    retryMs?: number
  ): TitleResult {
    return {
      lastError,
      nextAttemptAt:
        retryMs === undefined ? undefined : new Date(this.now() + retryMs),
      answered: false,
    };
  }

  /** Searches one title and records the outcome; writes nothing on cancel. */
  private async resolveTitle(
    run: RunState,
    instance: InstanceRun,
    anilistId: number
  ): Promise<Next> {
    const startedAt = new Date(this.now());
    const record = (result: TitleResult) =>
      this.record(run, instance.snapshot.id, anilistId, startedAt, result);
    try {
      const outcome = await this.searchTitle(run, instance, anilistId);
      if (outcome === 'over-budget') return 'stop-instance';
      run.counts.titles += 1;
      await record(outcome.result);
      return outcome.next;
    } catch (error) {
      if (run.signal.aborted) return 'stop-run';
      run.counts.titles += 1;
      if (
        error instanceof InstanceFailure ||
        (error instanceof MangaResolveError &&
          error.code === 'MANGA_INSTANCE_CHANGED')
      ) {
        logger.warn('Manga source resolve stopped for an instance', {
          label: LABEL,
          instanceId: instance.snapshot.id,
          code: error.code,
        });
        await record(this.deferred('SUWAYOMI_UNAVAILABLE'));
        return 'stop-instance';
      }
      if (error instanceof MangaResolveError) {
        await record(this.deferred('BIND_FAILED', SHORT_RETRY_MS));
        return 'continue';
      }
      throw error;
    }
  }

  private async searchTitle(
    run: RunState,
    instance: InstanceRun,
    anilistId: number
  ): Promise<'over-budget' | { result: TitleResult; next: Next }> {
    const { snapshot } = instance;
    const done = (result: TitleResult, next: Next = 'continue') => ({
      result,
      next,
    });
    const bound = (
      reason: MangaResolveReason,
      candidates?: Found[]
    ): TitleResult => ({
      status: MangaResolutionStatus.BOUND,
      reason,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      candidates,
      searched: candidates !== undefined,
      answered: true,
    });

    if (
      await hasActiveMangaBinding(dataSource.manager, anilistId, snapshot.id)
    ) {
      await catchUpMangaResolverTitle(snapshot, anilistId);
      return done(bound('EXISTING_BINDING'));
    }

    let details: AnilistMangaDetails | null;
    try {
      run.signal.throwIfAborted();
      details = await run.anilist.getMangaDetails(anilistId);
      run.signal.throwIfAborted();
    } catch (error) {
      if (run.signal.aborted) throw error;
      if (error instanceof AnilistRateLimitedError) {
        return done(this.deferred('ANILIST_RATE_LIMITED'), 'stop-run');
      }
      const result = this.deferred('ANILIST_FAILED', SHORT_RETRY_MS);
      return done(
        result,
        error instanceof AnilistOutageError ? 'stop-run' : 'continue'
      );
    }
    const policy = getMangaContentPolicy();
    if (!details || isAnilistMangaExcluded(details, policy)) {
      return done({
        status: MangaResolutionStatus.EXCLUDED,
        reason: details ? 'CONTENT_POLICY' : 'ANILIST_NOT_FOUND',
        mangadexUuid: null,
        attempts: 0,
        nextAttemptAt: new Date(this.now() + EXCLUDED_RECHECK_MS),
        lastError: null,
        candidates: [],
        answered: true,
      });
    }

    const sources = await this.sourcesOf(run, instance);
    // Fuzzy searches follow the content policy. Exact probes need not: a hit
    // must carry the exact link of a title that passed it.
    const fuzzySources = (
      policy.includeAdult
        ? sources
        : sources.filter((source) => source.contentWarning === 'SAFE')
    ).slice(0, this.limits.fuzzySourcesPerTitle);
    const worst =
      Math.min(
        this.limits.probesPerTitle,
        sources.length * this.limits.ambiguousUuids
      ) +
      this.limits.queriesPerSource * fuzzySources.length;
    if (
      instance.searches > 0 &&
      instance.searches + worst > this.limits.searchesPerInstance
    ) {
      return 'over-budget';
    }
    if (sources.length === 0) {
      // Nothing could take the title, so MangaDex is not asked either.
      return done({
        status: MangaResolutionStatus.NO_MATCH,
        reason: 'NO_ELIGIBLE_SOURCES',
        attempts: NEXT_ON_LADDER,
        lastError: null,
        candidates: [],
        answered: true,
      });
    }

    let uuids: string[] = [];
    let mangadexFailed = false;
    try {
      uuids = await this.linkedUuids(run, details, anilistId);
    } catch (error) {
      if (run.signal.aborted) throw error;
      if (error instanceof MangaDexRateLimitedError) {
        return done(this.deferred('MANGADEX_COOLDOWN'), 'stop-run');
      }
      mangadexFailed = true;
    }

    const title = new AbortController();
    const signal = AbortSignal.any([run.signal, title.signal]);
    const progress = { failed: 0, succeeded: 0 };
    const exactHits: Hit[] = [];
    const probes = this.planProbes(snapshot.id, sources, uuids);
    await runPool(
      probes,
      this.limits.concurrency,
      title,
      async ({ source, uuid }) => {
        const page = await this.search(
          run,
          instance,
          signal,
          source,
          `id:${uuid}`
        );
        if (page === 'over-budget' || page === 'failed') {
          progress.failed += 1;
          if (page === 'failed')
            this.remember(snapshot.id, source.id, 'failed');
          return;
        }
        progress.succeeded += 1;
        const hit = page.mangas
          .filter((manga) => mangadexUuidOf(manga.url) === uuid)
          .map((manga) => toHit(source, manga))
          .find((found) => found !== undefined);
        this.remember(snapshot.id, source.id, hit ? 'hit' : 'miss');
        if (hit) exactHits.push(hit);
      }
    );

    const exact = this.rankExact(exactHits, snapshot);
    let exactReason: MangaResolveReason | undefined;
    if (uuids.length === 1 && exact.length > 0) {
      const [top] = exact;
      if (
        languageRank(top.source.lang, snapshot.preferredLanguages) === undefined
      ) {
        exactReason = 'EXACT_NOT_PREFERRED';
      } else if (top.manga.inLibrary) {
        exactReason = 'EXACT_IN_LIBRARY';
      } else {
        run.signal.throwIfAborted();
        const write = await writeMangaResolverBinding(
          {
            snapshot,
            anilistId,
            sourceId: top.source.id,
            url: top.manga.url,
            suwayomiMangaId: top.suwayomiMangaId,
            title: top.title,
            exact: true,
          },
          'auto',
          run.signal
        );
        if (write.outcome !== 'skipped') {
          return done({
            ...bound('EXACT_LINK', this.asExact(exact.slice(1))),
            mangadexUuid: uuids[0],
          });
        }
        if (write.reason === 'EXISTING_BINDING') {
          return done(bound('EXISTING_BINDING'));
        }
        exactReason =
          write.reason === 'BOUND_ELSEWHERE'
            ? 'EXACT_BOUND_ELSEWHERE'
            : 'EXACT_REJECTED';
      }
    }

    const fuzzy = new Map<string, Found>();
    const profile = mangaResolverProfile(details);
    await runPool(
      fuzzySources,
      this.limits.concurrency,
      title,
      async (source) => {
        const scored: { hit: Hit; score: number }[] = [];
        const seen = new Set<string>();
        for (const query of sourceQueries(
          details,
          source.lang,
          this.limits.queriesPerSource
        )) {
          const page = await this.search(run, instance, signal, source, query);
          if (page === 'over-budget' || page === 'failed') {
            progress.failed += 1;
            return;
          }
          progress.succeeded += 1;
          for (const manga of page.mangas) {
            const hit = toHit(source, manga);
            if (!hit || seen.has(manga.url)) continue;
            seen.add(manga.url);
            const uuid = mangadexUuidOf(manga.url);
            // An exact link that a title search found is offered, never bound.
            if (uuid !== undefined && uuids.includes(uuid)) {
              exactHits.push(hit);
              continue;
            }
            scored.push({ hit, score: scoreSourceManga(profile, manga) });
          }
          if (scored.some(({ score }) => score >= MANGA_TITLE_MEDIUM_SCORE)) {
            break;
          }
        }
        scored.sort((a, b) => b.score - a.score);
        const [best, runnerUp] = scored;
        const confidence =
          best &&
          rateSourceMatch(best.score, runnerUp?.score ?? 0, profile.capped);
        if (best && confidence) {
          fuzzy.set(source.id, {
            ...best.hit,
            score: best.score,
            confidence,
            matchedBy: MANGA_MATCHED_BY_TITLE,
          });
        }
      }
    );

    const exactFound = this.asExact(this.rankExact(exactHits, snapshot));
    const exactKeys = new Set(exactFound.map(hitKey));
    const candidates = [
      ...exactFound,
      ...[...fuzzy.values()]
        .filter((found) => !exactKeys.has(hitKey(found)))
        .sort((a, b) => b.score - a.score || a.source.rank - b.source.rank),
    ].slice(0, this.limits.candidatesPerTitle);
    if (exactReason === undefined && exactFound.length > 0) {
      exactReason = 'EXACT_BY_TITLE';
    }
    // A search that missed MangaDex or a source proves little: it never
    // grows the backoff and runs again soon.
    const incomplete = mangadexFailed || progress.failed > 0;
    const lastError: MangaResolveFailure | null = mangadexFailed
      ? 'MANGADEX_FAILED'
      : progress.failed > 0
        ? 'SOURCE_SEARCH_FAILED'
        : null;
    if (progress.failed > 0 && progress.succeeded === 0) {
      // No source answered, so the title keeps its status and candidates.
      return done({
        nextAttemptAt: new Date(this.now() + SHORT_RETRY_MS),
        lastError,
        answered: true,
      });
    }
    const searched = {
      mangadexUuid: mangadexFailed ? undefined : (uuids[0] ?? null),
      candidates,
      searched: true,
      answered: true,
      lastError,
    };
    if (candidates.length > 0 || uuids.length > 1) {
      return done({
        ...searched,
        status: MangaResolutionStatus.NEEDS_PICK,
        reason:
          uuids.length > 1
            ? 'MANGADEX_AMBIGUOUS'
            : (exactReason ?? 'TITLE_MATCHES'),
        attempts: 0,
        nextAttemptAt: new Date(
          this.now() + (incomplete ? SHORT_RETRY_MS : LONG_RETRY_MS)
        ),
      });
    }
    if (incomplete) {
      return done({
        ...searched,
        status: MangaResolutionStatus.NO_MATCH,
        reason: mangadexFailed ? 'MANGADEX_FAILED' : 'NO_CANDIDATES',
        nextAttemptAt: new Date(this.now() + SHORT_RETRY_MS),
      });
    }
    return done({
      ...searched,
      status: MangaResolutionStatus.NO_MATCH,
      reason:
        probes.length + fuzzySources.length > 0
          ? 'NO_CANDIDATES'
          : 'NO_ELIGIBLE_SOURCES',
      attempts: NEXT_ON_LADDER,
    });
  }

  /** MangaDex manga that link to the title; stops at the first search with one. */
  private async linkedUuids(
    run: RunState,
    details: AnilistMangaDetails,
    anilistId: number
  ): Promise<string[]> {
    const found = new Set<string>();
    for (const query of mangadexQueries(details, this.limits.mangadexQueries)) {
      run.signal.throwIfAborted();
      const matches = await run.mangadex.searchMangaByTitle(query, {
        signal: run.signal,
      });
      for (const match of matches) {
        if (match.anilistId === anilistId) found.add(match.uuid);
      }
      if (found.size > 0) break;
    }
    return [...found].slice(0, this.limits.ambiguousUuids);
  }

  /** Allowlisted, installed sources in allowlist order, read once a run. */
  private async sourcesOf(
    run: RunState,
    instance: InstanceRun
  ): Promise<RankedSource[]> {
    if (instance.sources) return instance.sources;
    try {
      const options = { signal: run.signal };
      const capabilities = await instance.client.getCapabilities(options);
      if (!capabilities.supported || capabilities.perUserDownloadState) {
        throw new InstanceFailure('UNSUPPORTED_SERVER');
      }
      const installed = new Map(
        (await instance.client.getSources(options)).map((source) => [
          source.id,
          source,
        ])
      );
      instance.sources = instance.snapshot.sourceAllowlist.flatMap(
        (id, rank) => {
          const source = installed.get(id);
          return source && id !== '0' ? [{ ...source, rank }] : [];
        }
      );
      return instance.sources;
    } catch (error) {
      if (run.signal.aborted || error instanceof InstanceFailure) throw error;
      throw new InstanceFailure(
        error instanceof SuwayomiError ? error.code : 'UNKNOWN'
      );
    }
  }

  /**
   * Known-positive sources first, then each source no probe has confirmed
   * and none has tried lately; every source gets each UUID, up to the cap.
   */
  private planProbes(
    instanceId: number,
    sources: readonly RankedSource[],
    uuids: readonly string[]
  ): { source: RankedSource; uuid: string }[] {
    if (uuids.length === 0) return [];
    const now = this.now();
    const due = sources.filter((source) => {
      const known = this.probes.get(`${instanceId}:${source.id}`);
      return !known || known.positive || now >= known.recheckAt;
    });
    // Sources known to answer go first.
    const positive = (source: RankedSource) =>
      this.probes.get(`${instanceId}:${source.id}`)?.positive ? 0 : 1;
    return [...due]
      .sort((a, b) => positive(a) - positive(b) || a.rank - b.rank)
      .flatMap((source) => uuids.map((uuid) => ({ source, uuid })))
      .slice(0, this.limits.probesPerTitle);
  }

  /**
   * A hit marks the source as answering `id:` probes for good. Otherwise it
   * waits before its next probe: long after a miss, briefly after a failure.
   */
  private remember(
    instanceId: number,
    sourceId: string,
    outcome: 'hit' | 'miss' | 'failed'
  ) {
    const key = `${instanceId}:${sourceId}`;
    if (outcome === 'hit') {
      this.probes.set(key, { positive: true, recheckAt: 0 });
    } else if (!this.probes.get(key)?.positive) {
      this.probes.set(key, {
        positive: false,
        recheckAt:
          this.now() +
          (outcome === 'miss' ? this.limits.probeRecheckMs : SHORT_RETRY_MS),
      });
    }
  }

  /**
   * Distinct exact hits, by the source language's place in the preferred
   * languages (other languages last), then by allowlist order.
   */
  private rankExact(hits: readonly Hit[], snapshot: SuwayomiSettings): Hit[] {
    const order = (hit: Hit) =>
      languageRank(hit.source.lang, snapshot.preferredLanguages) ?? Infinity;
    const seen = new Set<string>();
    return [...hits]
      .sort((a, b) => order(a) - order(b) || a.source.rank - b.source.rank)
      .filter((hit) => {
        if (seen.has(hitKey(hit))) return false;
        seen.add(hitKey(hit));
        return true;
      });
  }

  private asExact(hits: readonly Hit[]): Found[] {
    return hits.map((hit) => ({
      ...hit,
      score: 1000,
      confidence: MangaBindingConfidence.EXACT_LINK,
      matchedBy: MANGA_MATCHED_BY_MANGADEX_LINK,
    }));
  }

  /**
   * One source search under the run's budget and a per-search timeout.
   * 'failed' when the search failed for this source only; throws when the
   * instance failed or the title's work was aborted.
   */
  private async search(
    run: RunState,
    instance: InstanceRun,
    signal: AbortSignal,
    source: RankedSource,
    query: string
  ): Promise<SuwayomiSearchPage | 'failed' | 'over-budget'> {
    signal.throwIfAborted();
    if (instance.searches >= this.limits.searchesPerInstance) {
      return 'over-budget';
    }
    instance.searches += 1;
    run.counts.searches += 1;
    const timeout = AbortSignal.timeout(this.limits.searchTimeoutMs);
    try {
      return await instance.client.searchSource(source.id, query, 1, {
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const code = error instanceof SuwayomiError ? error.code : undefined;
      if (code && INSTANCE_FAILURES.has(code) && !timeout.aborted) {
        throw new InstanceFailure(code);
      }
      run.counts.searchFailures += 1;
      return 'failed';
    }
  }

  /**
   * Stores the outcome under the title's request admission. A title that
   * gained an ACTIVE binding meanwhile is BOUND, and a deferred title that
   * lost its binding is QUEUED; an admin search made after the title's run
   * began stays pending.
   */
  private async record(
    run: RunState,
    instanceId: number,
    anilistId: number,
    startedAt: Date,
    result: TitleResult
  ): Promise<void> {
    await runWithRequestAdmission([getMangaAdmissionKey(anilistId)], () =>
      dataSource.transaction(async (manager) => {
        run.signal.throwIfAborted();
        const row =
          (await manager.findOneBy(MangaSourceResolution, {
            instanceId,
            anilistId,
          })) ?? new MangaSourceResolution({ instanceId, anilistId });
        const previous = row.attempts ?? 0;
        let next = { ...result };
        if (result.status !== MangaResolutionStatus.BOUND) {
          if (await hasActiveMangaBinding(manager, anilistId, instanceId)) {
            next = {
              ...result,
              status: MangaResolutionStatus.BOUND,
              reason: 'EXISTING_BINDING',
              attempts: 0,
              nextAttemptAt: null,
              lastError: null,
            };
          } else if (
            result.status === undefined &&
            row.status === MangaResolutionStatus.BOUND
          ) {
            next = {
              ...result,
              status: MangaResolutionStatus.QUEUED,
              reason: null,
            };
          }
        }
        if (next.status !== undefined) row.status = next.status;
        if (next.reason !== undefined) row.reason = next.reason;
        if (next.mangadexUuid !== undefined) {
          row.mangadexUuid = next.mangadexUuid;
        }
        const attempts =
          next.attempts === NEXT_ON_LADDER
            ? previous + 1
            : (next.attempts ?? previous);
        row.attempts = attempts;
        row.nextAttemptAt =
          next.attempts === NEXT_ON_LADDER
            ? new Date(this.now() + mangaNoMatchDelayMs(attempts))
            : next.nextAttemptAt === undefined
              ? (row.nextAttemptAt ?? null)
              : next.nextAttemptAt;
        row.lastError = next.lastError;
        row.checkedAt = new Date(this.now());
        if (next.searched) row.searchedAt = row.checkedAt;
        if (
          next.answered &&
          row.searchRequestedAt &&
          row.searchRequestedAt.getTime() <= startedAt.getTime()
        ) {
          row.searchRequestedAt = null;
        }
        await manager.save(row);
        if (next.candidates !== undefined) {
          await manager.delete(MangaSourceCandidate, { instanceId, anilistId });
          if (next.candidates.length > 0) {
            await manager.insert(
              MangaSourceCandidate,
              next.candidates.map((found) => ({
                instanceId,
                anilistId,
                sourceId: found.source.id,
                sourceName: found.source.displayName || found.source.name,
                sourceLang: found.source.lang,
                url: found.manga.url,
                urlHash: hashMangaSourceUrl(found.manga.url),
                suwayomiMangaId: found.suwayomiMangaId,
                title: found.title,
                inLibrary: found.manga.inLibrary,
                score: found.score,
                confidence: found.confidence,
                matchedBy: found.matchedBy,
              }))
            );
          }
        }
        this.tally(run.counts, row.status, next);
      })
    );
  }

  private tally(
    counts: MangaResolverCounts,
    status: MangaResolutionStatus,
    result: TitleResult
  ): void {
    if (
      result.status === undefined ||
      result.status === MangaResolutionStatus.QUEUED
    ) {
      counts.deferred += 1;
    } else if (status === MangaResolutionStatus.BOUND) {
      counts.bound += 1;
    } else if (status === MangaResolutionStatus.NEEDS_PICK) {
      counts.needsPick += 1;
    } else if (status === MangaResolutionStatus.NO_MATCH) {
      counts.noMatch += 1;
    } else if (status === MangaResolutionStatus.EXCLUDED) {
      counts.excluded += 1;
    }
  }
}

export const mangaSourceResolver = new MangaSourceResolver();

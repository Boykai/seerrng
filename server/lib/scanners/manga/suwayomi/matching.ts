import AnilistAPI, {
  AnilistAuthError,
  AnilistBadResponseError,
  AnilistGraphQLError,
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist';
import type { AnilistMangaSummary } from '@server/api/anilist/manga';
import { ANILIST_MAL_LOOKUP_PAGE_SIZE } from '@server/api/anilist/manga';
import MangaDexAPI, {
  MANGADEX_MAX_IDS_PER_REQUEST,
  MangaDexBadResponseError,
  MangaDexRateLimitedError,
} from '@server/api/mangadex';
import type { SuwayomiLibraryItem } from '@server/api/suwayomi/types';
import type MangaMatchCandidate from '@server/entity/MangaMatchCandidate';
import {
  MANGA_MATCHED_BY_MAL_TRACKER,
  MANGA_MATCHED_BY_MANGADEX_LINK,
  MANGA_MATCHED_BY_TITLE,
  MangaBindingConfidence,
} from '@server/entity/MangaSourceBinding';
import { getMangaContentPolicy } from '@server/lib/mangaCatalog';
import type { MangaTitleProposal } from '@server/lib/mangaTitleMatch';
import {
  mangaTitleSearchText,
  normalizeMangaTitle,
  proposeMangaMatch,
} from '@server/lib/mangaTitleMatch';
import { chunk } from '@server/utils/chunk';
import axios from 'axios';
import { setTimeout as delay } from 'node:timers/promises';

/** A concluded lookup is due again after 30 days. */
export const MANGA_LOOKUP_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Scan lookups start at least 3 seconds apart: at most 20 a minute, about
 * two-thirds of AniList's shared budget, so people using SeerrNG during a
 * scan keep the rest.
 */
export const MANGA_LOOKUP_SPACING_MS = 3_000;
/**
 * The scan's AniList requests never queue for the shared budget. One that
 * would have to wait fails at once, and the scan waits instead, so its
 * requests start when it paced them and other requests keep their turn.
 */
const SCAN_ANILIST_OPTIONS = { maxRateLimitWaitMs: 0 };
/** A rate limit or cooldown asking for a longer wait ends its step. */
export const MANGA_LOOKUP_MAX_WAIT_MS = 15 * 60 * 1000;
/**
 * The third time AniList or MangaDex refuses the same lookup in a row ends
 * its step for the run. Waits for the shared request budget never count.
 */
export const MANGA_LOOKUP_MAX_REFUSALS = 3;
/** A MyAnimeList batch with more result pages than this counts as failed. */
export const MAL_LOOKUP_MAX_PAGES = 10;

// Recognized by shape alone, whichever source the item comes from.
const MANGADEX_URL =
  /^\/manga\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type LookupStep = 'mal' | 'mangadex' | 'title';

/** One scan run's lookup state, shared by every instance. */
export interface LookupRun {
  /** The earliest start of the next lookup, in epoch milliseconds. */
  nextCallAt: number;
  /** Steps a failure ended for the rest of the run. */
  stopped: Set<LookupStep>;
}

export const newLookupRun = (): LookupRun => ({
  nextCallAt: 0,
  stopped: new Set(),
});

/** Waits `ms`, or rejects as soon as `signal` aborts. */
type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

interface LookupClock {
  now: () => number;
  sleep: Sleep;
}

const systemClock: LookupClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
};
let clock = systemClock;

/** Test helper: replaces the lookup clock; no options restore the real one. */
export const setMangaLookupClockForTests = (
  options: Partial<LookupClock> = {}
): void => {
  clock = { ...systemClock, ...options };
};

export type MatchingWarning =
  | 'AMBIGUOUS_MAL_LINK'
  | 'MAL_LOOKUP_FAILED'
  | 'MANGADEX_LOOKUP_FAILED'
  | 'TITLE_SEARCH_FAILED';

/** The valid AniList and MyAnimeList IDs in an item's tracker records. */
export interface TrackerEvidence {
  anilistIds: ReadonlySet<number>;
  malIds: ReadonlySet<number>;
}

/** The user's own tracker records disagree, so nothing binds automatically. */
export const hasTrackerConflict = ({ anilistIds, malIds }: TrackerEvidence) =>
  anilistIds.size > 1 || malIds.size > 1;

/** Lookup progress and proposal values for the item's candidate row. */
export type CandidateProgress = Partial<
  Pick<
    MangaMatchCandidate,
    | 'malId'
    | 'malCheckedAt'
    | 'mangadexCheckedAt'
    | 'titleCheckedAt'
    | 'proposedAnilistId'
    | 'proposalConfidence'
    | 'proposalScore'
  >
>;

export type MatchLink = {
  kind: 'link';
  anilistId: number;
  confidence: MangaBindingConfidence;
  matchedBy: string;
};

export type MatchTarget =
  MatchLink | { kind: 'candidate'; progress: CandidateProgress };

export interface MatchInput {
  item: SuwayomiLibraryItem;
  evidence: TrackerEvidence;
  /** AniList IDs an admin refused for this item; never linked or proposed. */
  rejected: ReadonlySet<number>;
  candidate?: MangaMatchCandidate;
}

export interface MatchingContext {
  signal: AbortSignal;
  /** Pacing and stopped steps, shared by every instance in the run. */
  lookups: LookupRun;
  warn: (code: MatchingWarning, count: number, cause?: string) => void;
  /** Items a step stopped earlier in the run left for a later run. */
  defer: (step: LookupStep, count: number) => void;
  /** Items whose matching is finished for this run. */
  handled: (count: number) => void;
}

interface Match {
  input: MatchInput;
  progress: CandidateProgress;
  link?: MatchLink;
  /** A step got no answer, so the later steps wait for another run. */
  pending: boolean;
}

type CallResult<T> = { value: T } | { cause?: string };

/** A stable cause for logs, never upstream text. */
export const lookupFailureCode = (error: unknown): string => {
  if (
    error instanceof AnilistRateLimitedError ||
    error instanceof MangaDexRateLimitedError
  ) {
    return error.requestSent ? 'RATE_LIMITED' : 'COOLDOWN';
  }
  if (error instanceof AnilistOutageError) return 'OUTAGE';
  if (error instanceof AnilistAuthError) return 'AUTH_ERROR';
  if (error instanceof AnilistGraphQLError) return 'GRAPHQL_ERROR';
  if (
    error instanceof AnilistBadResponseError ||
    error instanceof MangaDexBadResponseError
  ) {
    return 'BAD_RESPONSE';
  }
  if (axios.isAxiosError(error)) {
    return error.response
      ? `HTTP_${error.response.status}`
      : (error.code ?? 'NETWORK_ERROR');
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
};

/** The lowercase MangaDex UUID of a `/manga/<uuid>` URL. */
export const mangadexUuidOf = (url: string): string | undefined =>
  MANGADEX_URL.exec(url)?.[1].toLowerCase();

const linkTo = (
  anilistId: number,
  confidence: MangaBindingConfidence,
  matchedBy: string
): MatchLink => ({ kind: 'link', anilistId, confidence, matchedBy });

const isDue = (checkedAt: Date | null | undefined, now: Date) =>
  !checkedAt || now.getTime() - checkedAt.getTime() >= MANGA_LOOKUP_RECHECK_MS;

/** Never-checked work first, then the oldest check, then the lower ID. */
const byAge =
  (checkedAt: (match: Match) => Date | null | undefined) =>
  (a: Match, b: Match) =>
    (checkedAt(a)?.getTime() ?? 0) - (checkedAt(b)?.getTime() ?? 0) ||
    Number(a.input.item.id) - Number(b.input.item.id);

/** Holds a lookup until the spacing since the run's previous one passed. */
const pace = async ({ lookups, signal }: MatchingContext): Promise<void> => {
  const wait = lookups.nextCallAt - clock.now();
  if (wait > 0) await clock.sleep(wait, signal);
  signal.throwIfAborted();
  lookups.nextCallAt = clock.now() + MANGA_LOOKUP_SPACING_MS;
};

/** A rate limit or cooldown, which asks for a wait before the next send. */
const refusalOf = (error: unknown) =>
  error instanceof AnilistRateLimitedError ||
  error instanceof MangaDexRateLimitedError
    ? error
    : undefined;

/**
 * One paced lookup of a step. A rate limit or cooldown waits as long as asked
 * and sends again, unless the wait would pass 15 minutes or the service
 * refused the lookup three times in a row; those end the step for the run,
 * as any other failure does unless `stops` says it concerns this call alone.
 * A stopped step returns no cause. A cancel always throws, during a wait too.
 */
const call = async <T>(
  context: MatchingContext,
  step: LookupStep,
  send: () => Promise<T>,
  stops: (error: unknown) => boolean = () => true
): Promise<CallResult<T>> => {
  const { lookups, signal } = context;
  if (lookups.stopped.has(step)) return {};
  let refusals = 0;
  for (;;) {
    await pace(context);
    try {
      const value = await send();
      signal.throwIfAborted();
      return { value };
    } catch (error) {
      if (signal.aborted) throw error;
      const refusal = refusalOf(error);
      if (refusal?.requestSent) refusals += 1;
      const wait = Math.max(1, refusal?.retryAfterSeconds || 1) * 1000;
      if (
        refusal &&
        wait <= MANGA_LOOKUP_MAX_WAIT_MS &&
        refusals < MANGA_LOOKUP_MAX_REFUSALS
      ) {
        await clock.sleep(wait, signal);
        continue;
      }
      if (refusal || stops(error)) lookups.stopped.add(step);
      return { cause: lookupFailureCode(error) };
    }
  }
};

/**
 * Looks up the due items in batches of distinct keys. Only a batch answered
 * in full concludes; it and every later batch otherwise stay pending.
 */
const lookUpInBatches = async <Key, Answer>(
  due: readonly Match[],
  keyOf: (match: Match) => Key,
  batchSize: number,
  read: (keys: Key[]) => Promise<Map<Key, Answer> | { cause?: string }>,
  conclude: (match: Match, answer: Answer | undefined, key: Key) => void
): Promise<{ pending: number; cause?: string }> => {
  const byKey = new Map<Key, Match[]>();
  for (const match of due) {
    const key = keyOf(match);
    byKey.set(key, [...(byKey.get(key) ?? []), match]);
  }
  const batches = chunk([...byKey.keys()], batchSize);
  for (const [index, keys] of batches.entries()) {
    const answers = await read(keys);
    if (!(answers instanceof Map)) {
      const pending = batches
        .slice(index)
        .flat()
        .flatMap((key) => byKey.get(key) ?? []);
      for (const match of pending) match.pending = true;
      return { pending: pending.length, cause: answers.cause };
    }
    for (const key of keys) {
      for (const match of byKey.get(key) ?? []) {
        conclude(match, answers.get(key), key);
      }
    }
  }
  return { pending: 0 };
};

const singleMalId = ({ input }: Match) =>
  input.evidence.malIds.size === 1 ? [...input.evidence.malIds][0] : undefined;

/** Step 3: the AniList manga that name the item's MyAnimeList ID. */
const matchMalIds = async (
  context: MatchingContext,
  matches: readonly Match[],
  now: Date,
  anilist: () => AnilistAPI
) => {
  // A check of another MAL ID says nothing about this one.
  const checkedAt = (match: Match) =>
    match.input.candidate?.malId === singleMalId(match)
      ? match.input.candidate?.malCheckedAt
      : null;
  const due = matches
    .filter((match) => singleMalId(match) && isDue(checkedAt(match), now))
    .sort(byAge(checkedAt));
  let ambiguous = 0;
  const { pending, cause } = await lookUpInBatches(
    due,
    (match) => singleMalId(match) as number,
    ANILIST_MAL_LOOKUP_PAGE_SIZE,
    async (malIds) => {
      // One MAL ID can name several AniList manga, so every page is read
      // before any ID in the batch is decided.
      const found = new Map<number, Set<number>>();
      for (let page = 1; page <= MAL_LOOKUP_MAX_PAGES; page += 1) {
        const result = await call(context, 'mal', () =>
          anilist().getMangaIdsByMalIds(malIds, page, {
            signal: context.signal,
          })
        );
        if (!('value' in result)) return result;
        for (const { anilistId, malId } of result.value.links) {
          found.set(malId, new Set(found.get(malId)).add(anilistId));
        }
        if (!result.value.hasNextPage) return found;
      }
      // Pages without end are no answer, and no later batch would do better.
      context.lookups.stopped.add('mal');
      return { cause: 'BAD_RESPONSE' };
    },
    (match, found, malId) => {
      // Several AniList manga for one MAL ID bind nothing, even when an admin
      // rejected all but one of them.
      const ids = [...(found ?? [])];
      if (ids.length === 1 && !match.input.rejected.has(ids[0])) {
        match.link = linkTo(
          ids[0],
          MangaBindingConfidence.TRACKER_LINK,
          MANGA_MATCHED_BY_MAL_TRACKER
        );
        return;
      }
      if (ids.length > 1) ambiguous += 1;
      match.progress.malId = malId;
      match.progress.malCheckedAt = now;
    }
  );
  if (ambiguous > 0) context.warn('AMBIGUOUS_MAL_LINK', ambiguous);
  if (cause) context.warn('MAL_LOOKUP_FAILED', pending, cause);
  else if (pending > 0) context.defer('mal', pending);
};

/** Step 4: the AniList link MangaDex keeps for a `/manga/<uuid>` item. */
const matchMangaDexLinks = async (
  context: MatchingContext,
  matches: readonly Match[],
  now: Date
) => {
  const checkedAt = (match: Match) => match.input.candidate?.mangadexCheckedAt;
  const due = matches
    .filter(
      (match) =>
        mangadexUuidOf(match.input.item.url) && isDue(checkedAt(match), now)
    )
    .sort(byAge(checkedAt));
  let client: MangaDexAPI | undefined;
  const { pending, cause } = await lookUpInBatches(
    due,
    (match) => mangadexUuidOf(match.input.item.url) as string,
    MANGADEX_MAX_IDS_PER_REQUEST,
    async (uuids) => {
      const result = await call(context, 'mangadex', () =>
        (client ??= new MangaDexAPI()).getAniListLinks(uuids, {
          signal: context.signal,
        })
      );
      return 'value' in result ? result.value : result;
    },
    (match, anilistId) => {
      if (anilistId && !match.input.rejected.has(anilistId)) {
        match.link = linkTo(
          anilistId,
          MangaBindingConfidence.EXACT_LINK,
          MANGA_MATCHED_BY_MANGADEX_LINK
        );
      } else {
        match.progress.mangadexCheckedAt = now;
      }
    }
  );
  if (cause) context.warn('MANGADEX_LOOKUP_FAILED', pending, cause);
  else if (pending > 0) context.defer('mangadex', pending);
};

// A rate limit, an outage, a refusal or an unreachable AniList affects every
// search; any other failure concerns one title and skips only that one.
const stopsTitleSearch = (error: unknown) =>
  error instanceof AnilistRateLimitedError ||
  error instanceof AnilistOutageError ||
  error instanceof AnilistAuthError ||
  (axios.isAxiosError(error) && !error.response);

const titleLink = (anilistId: number): MatchLink =>
  linkTo(anilistId, MangaBindingConfidence.HIGH, MANGA_MATCHED_BY_TITLE);

/**
 * A HIGH proposal binds unless the result is a novel or the item's own
 * tracker records disagree or name another title. A rejected title is never
 * proposed in the first place.
 */
const bindsByTitle = (
  { evidence, rejected }: MatchInput,
  proposal: MangaTitleProposal,
  results: readonly AnilistMangaSummary[]
): boolean => {
  const best = results.find(({ id }) => id === proposal.anilistId);
  return (
    proposal.confidence === MangaBindingConfidence.HIGH &&
    best !== undefined &&
    best.format !== 'NOVEL' &&
    !rejected.has(best.id) &&
    !hasTrackerConflict(evidence) &&
    [...evidence.anilistIds].every((id) => id === best.id) &&
    (evidence.malIds.size === 0 ||
      (best.idMal !== undefined && evidence.malIds.has(best.idMal)))
  );
};

/**
 * The item holds a HIGH proposal for its current title that no admin refused,
 * and has no tracker records that could argue against it.
 */
const hasStoredHighProposal = ({ input }: Match): boolean => {
  const { item, candidate, evidence, rejected } = input;
  const anilistId = candidate?.proposedAnilistId;
  return (
    candidate?.title === item.title &&
    candidate.proposalConfidence === MangaBindingConfidence.HIGH &&
    typeof anilistId === 'number' &&
    !rejected.has(anilistId) &&
    evidence.anilistIds.size === 0 &&
    evidence.malIds.size === 0
  );
};

/**
 * Step 5: an AniList title search. A HIGH match binds; any other best match
 * is stored as a proposal for admin review.
 */
const matchTitles = async (
  context: MatchingContext,
  matches: readonly Match[],
  now: Date,
  anilist: () => AnilistAPI
) => {
  const checkedAt = ({ progress, input }: Match) =>
    'titleCheckedAt' in progress
      ? progress.titleCheckedAt
      : input.candidate?.titleCheckedAt;
  const policy = getMangaContentPolicy();
  // A stored HIGH proposal may come from the Manga Source Resolve job, which
  // ranks library titles by score alone, or predate the current rules and
  // content settings. It is searched again at once, and the new result
  // decides whether the item binds.
  const due = matches.filter(
    (match) => hasStoredHighProposal(match) || isDue(checkedAt(match), now)
  );
  context.handled(matches.length - due.length);
  due.sort(byAge(checkedAt));
  let failed = 0;
  let deferred = 0;
  let firstCause: string | undefined;
  for (const match of due) {
    const { item, rejected } = match.input;
    let results: AnilistMangaSummary[] = [];
    // A title with no letters or digits concludes without a search.
    if (normalizeMangaTitle(item.title)) {
      const result = await call(
        context,
        'title',
        () =>
          anilist().searchMangaTitles(
            mangaTitleSearchText(item.title),
            policy,
            {
              signal: context.signal,
            }
          ),
        stopsTitleSearch
      );
      if (!('value' in result)) {
        if (result.cause) {
          failed += 1;
          firstCause ??= result.cause;
        } else {
          deferred += 1;
        }
        context.handled(1);
        continue;
      }
      results = result.value;
    }
    const proposal = proposeMangaMatch(item.title, results, rejected);
    if (proposal && bindsByTitle(match.input, proposal, results)) {
      match.link = titleLink(proposal.anilistId);
    } else {
      Object.assign(match.progress, {
        proposedAnilistId: proposal?.anilistId ?? null,
        proposalConfidence: proposal?.confidence ?? null,
        proposalScore: proposal?.score ?? null,
        titleCheckedAt: now,
      });
    }
    context.handled(1);
  }
  if (failed > 0) context.warn('TITLE_SEARCH_FAILED', failed, firstCause);
  if (deferred > 0) context.defer('title', deferred);
};

/**
 * A proposal for an older title, or one an admin has since refused, is
 * cleared at once, whether or not a new search succeeds in this run.
 */
const staleProposal = ({
  item,
  candidate,
  rejected,
}: MatchInput): CandidateProgress =>
  candidate &&
  (candidate.title !== item.title ||
    (candidate.proposedAnilistId !== null &&
      rejected.has(candidate.proposedAnilistId)))
    ? {
        proposedAnilistId: null,
        proposalConfidence: null,
        proposalScore: null,
        titleCheckedAt: null,
      }
    : {};

/**
 * Cascade steps 3 to 5 for library items that steps 1 and 2 left unmatched,
 * with every network call made before any write. Step 3 resolves the item's
 * MyAnimeList tracker ID through AniList and step 4 the AniList link MangaDex
 * keeps for a `/manga/<uuid>` URL; both bind only an unambiguous, unrejected
 * exact link. Step 5 binds a confident title match, or stores a proposal an
 * admin must confirm. Every due item is looked up in the same run.
 */
export const resolveLibraryMatches = async (
  context: MatchingContext,
  inputs: readonly MatchInput[]
): Promise<Map<string, MatchTarget>> => {
  const now = new Date();
  const matches = inputs.map((input): Match => ({
    input,
    progress: staleProposal(input),
    pending: false,
  }));
  let client: AnilistAPI | undefined;
  const anilist = () => (client ??= new AnilistAPI(SCAN_ANILIST_OPTIONS));
  const open = (match: Match) => !match.link && !match.pending;
  // Disagreeing tracker records allow no automatic link, only a proposal.
  const linkable = matches.filter(
    (match) => !hasTrackerConflict(match.input.evidence)
  );
  await matchMalIds(context, linkable, now, anilist);
  await matchMangaDexLinks(context, linkable.filter(open), now);
  // A linked item is done, and a pending one waits for a later run.
  context.handled(matches.filter((match) => !open(match)).length);
  await matchTitles(context, matches.filter(open), now, anilist);
  return new Map(
    matches.map((match) => [
      match.input.item.id,
      match.link ?? { kind: 'candidate', progress: match.progress },
    ])
  );
};

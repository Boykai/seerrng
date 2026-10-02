import AnilistAPI, {
  AnilistAuthError,
  AnilistBadResponseError,
  AnilistGraphQLError,
  AnilistOutageError,
  AnilistRateLimitedError,
} from '@server/api/anilist';
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
  MangaBindingConfidence,
} from '@server/entity/MangaSourceBinding';
import { getMangaContentPolicy } from '@server/lib/mangaCatalog';
import type { MangaTitleCandidate } from '@server/lib/mangaTitleMatch';
import {
  mangaTitleSearchText,
  normalizeMangaTitle,
  proposeMangaMatch,
} from '@server/lib/mangaTitleMatch';
import { chunk } from '@server/utils/chunk';
import axios from 'axios';

export interface LookupBudget {
  mal: number;
  mangadex: number;
  title: number;
}

/** Calls each lookup may make in one scan run, across every instance. */
export const MANGA_LOOKUP_CALLS_PER_RUN: Readonly<LookupBudget> = {
  mal: 10,
  mangadex: 10,
  title: 10,
};
/** A concluded lookup is due again after 30 days. */
export const MANGA_LOOKUP_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

// Recognized by shape alone, whichever source the item comes from.
const MANGADEX_URL =
  /^\/manga\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const newLookupBudget = (): LookupBudget => ({
  ...MANGA_LOOKUP_CALLS_PER_RUN,
});

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
  lookups: LookupBudget;
  warn: (code: MatchingWarning, count: number, cause?: string) => void;
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

/**
 * One call against the step's per-run budget. An exhausted budget returns no
 * cause, since the cap is not a failure. A failure ends the step for the run
 * unless `stops` says it concerns this call alone. A cancel always throws.
 */
const call = async <T>(
  context: MatchingContext,
  step: keyof LookupBudget,
  send: () => Promise<T>,
  stops: (error: unknown) => boolean = () => true
): Promise<CallResult<T>> => {
  if (context.lookups[step] <= 0) return {};
  context.signal.throwIfAborted();
  context.lookups[step] -= 1;
  try {
    const value = await send();
    context.signal.throwIfAborted();
    return { value };
  } catch (error) {
    if (context.signal.aborted) throw error;
    if (stops(error)) context.lookups[step] = 0;
    return { cause: lookupFailureCode(error) };
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
      for (let page = 1; ; page += 1) {
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
    },
    (match, found, malId) => {
      const ids = [...(found ?? [])].filter(
        (id) => !match.input.rejected.has(id)
      );
      if (ids.length === 1) {
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
};

// A rate limit, an outage, a refusal or an unreachable AniList affects every
// search; any other failure concerns one title and skips only that one.
const stopsTitleSearch = (error: unknown) =>
  error instanceof AnilistRateLimitedError ||
  error instanceof AnilistOutageError ||
  error instanceof AnilistAuthError ||
  (axios.isAxiosError(error) && !error.response);

/** Step 5: a title proposal for admin review; it never binds. */
const proposeTitles = async (
  context: MatchingContext,
  matches: readonly Match[],
  now: Date,
  anilist: () => AnilistAPI
) => {
  const checkedAt = ({ progress, input }: Match) =>
    'titleCheckedAt' in progress
      ? progress.titleCheckedAt
      : input.candidate?.titleCheckedAt;
  const due = matches
    .filter((match) => isDue(checkedAt(match), now))
    .sort(byAge(checkedAt));
  const policy = getMangaContentPolicy();
  let failed = 0;
  let firstCause: string | undefined;
  for (const match of due) {
    const { item, rejected } = match.input;
    let results: MangaTitleCandidate[] = [];
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
        }
        continue;
      }
      results = result.value;
    }
    const proposal = proposeMangaMatch(item.title, results, rejected);
    Object.assign(match.progress, {
      proposedAnilistId: proposal?.anilistId ?? null,
      proposalConfidence: proposal?.confidence ?? null,
      proposalScore: proposal?.score ?? null,
      titleCheckedAt: now,
    });
  }
  if (failed > 0) context.warn('TITLE_SEARCH_FAILED', failed, firstCause);
};

/**
 * A proposal for an older title, or one an admin has since refused, is
 * cleared at once, whether or not a new search fits in this run.
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
 * exact link. Step 5 stores a title proposal, which an admin must confirm.
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
  const anilist = () => (client ??= new AnilistAPI());
  const open = (match: Match) => !match.link && !match.pending;
  // Disagreeing tracker records allow no automatic link, only a proposal.
  const linkable = matches.filter(
    (match) => !hasTrackerConflict(match.input.evidence)
  );
  await matchMalIds(context, linkable, now, anilist);
  await matchMangaDexLinks(context, linkable.filter(open), now);
  await proposeTitles(context, matches.filter(open), now, anilist);
  return new Map(
    matches.map((match) => [
      match.input.item.id,
      match.link ?? { kind: 'candidate', progress: match.progress },
    ])
  );
};

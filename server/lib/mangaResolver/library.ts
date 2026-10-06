import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import type SuwayomiAPI from '@server/api/suwayomi';
import { SUWAYOMI_TRACKER_IDS } from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import type {
  SuwayomiLibraryItem,
  SuwayomiTrackRecord,
} from '@server/api/suwayomi/types';
import dataSource from '@server/datasource';
import MangaMatchCandidate from '@server/entity/MangaMatchCandidate';
import MangaSourceBinding, {
  MANGA_MATCHED_BY_ANILIST_TRACKER,
  MANGA_MATCHED_BY_TITLE,
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import {
  MANGA_TITLE_HIGH_MARGIN,
  MANGA_TITLE_HIGH_SCORE,
  MANGA_TITLE_MEDIUM_SCORE,
  scoreMangaTitle,
  type MangaTitleConfidence,
} from '@server/lib/mangaTitleMatch';
import {
  hasTrackerConflict,
  type TrackerEvidence,
} from '@server/lib/scanners/manga/suwayomi/matching';
import type { SuwayomiSettings } from '@server/lib/settings';
import { runWithSuwayomiInstanceAdmission } from '@server/lib/suwayomi/instanceAdmission';
import { chunk } from '@server/utils/chunk';
import { In, type EntityManager } from 'typeorm';

const MAX_INT32 = 2_147_483_647;
const IDS_PER_READ = 100;
const HASHES_PER_READ = 500;

/** A library manga and its tracker records, read once a run. */
export interface MangaLibraryEntry {
  item: SuwayomiLibraryItem;
  suwayomiMangaId: number;
  /**
   * Absent when the server keeps no tracker records; 'unresolved' when they
   * could not be read.
   */
  evidence?: TrackerEvidence | 'unresolved';
}

export interface MangaLibraryProposal {
  entry: MangaLibraryEntry;
  score: number;
}

export type MangaLibraryMatch =
  | {
      kind: 'bind';
      entry: MangaLibraryEntry;
      confidence: MangaBindingConfidence;
      matchedBy: string;
    }
  | { kind: 'unconfirmed'; proposals: MangaLibraryProposal[] }
  | { kind: 'none' };

const toTrackerId = (remoteId: string): number | undefined =>
  /^[1-9]\d{0,9}$/.test(remoteId) && Number(remoteId) <= MAX_INT32
    ? Number(remoteId)
    : undefined;

const evidenceOf = (records: readonly SuwayomiTrackRecord[]) => {
  const ids = (trackerId: number) =>
    new Set(
      records.flatMap((record) => {
        const id =
          record.trackerId === trackerId
            ? toTrackerId(record.remoteId)
            : undefined;
        return id === undefined ? [] : [id];
      })
    );
  return {
    anilistIds: ids(SUWAYOMI_TRACKER_IDS.aniList),
    malIds: ids(SUWAYOMI_TRACKER_IDS.myAnimeList),
  };
};

/** Errors that fail one tracker batch; any other error is the caller's. */
const isBatchFailure = (error: unknown) =>
  error instanceof SuwayomiError &&
  (error.code === 'BAD_RESPONSE' || error.code === 'UPSTREAM_ERROR');

/**
 * Reads the instance's library and, when the server keeps them, the tracker
 * records of every entry. Only Suwayomi reads; a failed tracker batch leaves
 * its entries unresolved.
 */
export const readMangaLibrary = async (
  client: SuwayomiAPI,
  trackRecords: boolean,
  signal: AbortSignal
): Promise<MangaLibraryEntry[]> => {
  const listing = await client.listLibrary({ signal });
  const entries = listing.items.flatMap((item): MangaLibraryEntry[] => {
    const suwayomiMangaId = Number(item.id);
    return Number.isSafeInteger(suwayomiMangaId) &&
      suwayomiMangaId >= 1 &&
      suwayomiMangaId <= MAX_INT32
      ? [{ item, suwayomiMangaId }]
      : [];
  });
  if (!trackRecords) return entries;
  const evidence = new Map<string, TrackerEvidence | 'unresolved'>();
  for (const batch of chunk(entries, IDS_PER_READ)) {
    try {
      const results = await client.getTrackRecords(
        batch.map(({ item }) => item.id),
        { signal }
      );
      for (const { mangaId, records } of results) {
        evidence.set(mangaId, evidenceOf(records));
      }
    } catch (error) {
      if (!isBatchFailure(error)) throw error;
      for (const { item } of batch) evidence.set(item.id, 'unresolved');
    }
  }
  return entries.map((entry) => ({
    ...entry,
    evidence: evidence.get(entry.item.id) ?? {
      anilistIds: new Set(),
      malIds: new Set(),
    },
  }));
};

/**
 * How the entry's tracker records relate to the requested title. 'mal' is a
 * lone MyAnimeList record of the title's own MyAnimeList ID: it supports a
 * title match, but alone it binds nothing; the library scan resolves those.
 */
const trackerVerdict = (
  entry: MangaLibraryEntry,
  title: Pick<AnilistMangaDetails, 'id' | 'idMal'>
): 'exact' | 'mal' | 'contradicts' | 'conflict' | 'unknown' | 'clear' => {
  const { evidence } = entry;
  if (evidence === undefined) return 'clear';
  if (evidence === 'unresolved') return 'unknown';
  const { anilistIds, malIds } = evidence;
  if (anilistIds.size === 1 && anilistIds.has(title.id)) return 'exact';
  if (
    (anilistIds.size > 0 && !anilistIds.has(title.id)) ||
    (title.idMal !== undefined && malIds.size > 0 && !malIds.has(title.idMal))
  ) {
    return 'contradicts';
  }
  if (hasTrackerConflict(evidence)) return 'conflict';
  if (malIds.size === 0) return 'clear';
  // A MyAnimeList record that the title's own ID can't confirm proves nothing.
  return title.idMal === undefined ? 'unknown' : 'mal';
};

const confidenceOf = (score: number): MangaTitleConfidence =>
  score >= MANGA_TITLE_HIGH_SCORE
    ? MangaBindingConfidence.HIGH
    : score >= MANGA_TITLE_MEDIUM_SCORE
      ? MangaBindingConfidence.MEDIUM
      : MangaBindingConfidence.LOW;

const naturalKey = (sourceId: string, url: string) => `${sourceId}\n${url}`;

/**
 * Finds the requested title among the library entries. Exact evidence comes
 * first: one AniList tracker record that names the title. Then the title's
 * names and synonyms are compared with every entry's title; one clear,
 * uncontradicted match binds, and the request's AniList ID confirms it.
 * Likely entries that fall short wait for an admin. Entries with a live
 * binding, or whose pair with the title an admin rejected, never count.
 */
export const matchMangaLibrary = async (
  manager: EntityManager,
  instanceId: number,
  entries: readonly MangaLibraryEntry[],
  title: AnilistMangaDetails
): Promise<MangaLibraryMatch> => {
  const scored = entries.map((entry) => ({
    entry,
    score: scoreMangaTitle(entry.item.title, title),
    verdict: trackerVerdict(entry, title),
  }));
  const relevant = scored.filter(
    ({ score, verdict }) =>
      verdict === 'exact' ||
      verdict === 'mal' ||
      (verdict !== 'contradicts' && score >= MANGA_TITLE_MEDIUM_SCORE)
  );
  if (relevant.length === 0) return { kind: 'none' };

  const bindings = new Map<string, MangaSourceBinding[]>();
  const proposedElsewhere = new Set<string>();
  const urlHashes = [
    ...new Set(relevant.map(({ entry }) => hashMangaSourceUrl(entry.item.url))),
  ];
  for (const slice of chunk(urlHashes, HASHES_PER_READ)) {
    const where = { instanceId, urlHash: In(slice) };
    for (const row of await manager.find(MangaSourceBinding, { where })) {
      const key = naturalKey(row.sourceId, row.url);
      bindings.set(key, [...(bindings.get(key) ?? []), row]);
    }
    for (const row of await manager.find(MangaMatchCandidate, { where })) {
      if (
        row.proposedAnilistId !== null &&
        row.proposedAnilistId !== title.id
      ) {
        proposedElsewhere.add(naturalKey(row.sourceId, row.url));
      }
    }
  }
  // Without a live binding, a stored row is a rejection of that pair.
  const eligible = relevant.filter(({ entry: { item } }) => {
    const rows = bindings.get(naturalKey(item.sourceId, item.url)) ?? [];
    return (
      !rows.some((row) => row.state !== MangaBindingState.REJECTED) &&
      !rows.some((row) => row.anilistId === title.id)
    );
  });
  const byId = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    a.entry.suwayomiMangaId - b.entry.suwayomiMangaId;

  const [exact] = eligible
    .filter(({ verdict }) => verdict === 'exact')
    .sort(byId);
  if (exact) {
    return {
      kind: 'bind',
      entry: exact.entry,
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: MANGA_MATCHED_BY_ANILIST_TRACKER,
    };
  }

  // An entry the title's own MyAnimeList record names is likely at any score.
  const likely = eligible
    .filter(
      ({ score, verdict }) =>
        verdict === 'mal' || score >= MANGA_TITLE_MEDIUM_SCORE
    )
    .sort((a, b) => b.score - a.score || byId(a, b));
  const [top] = likely;
  if (!top) return { kind: 'none' };
  // Every other entry counts against the lead, eligible or not.
  const runnerUp = scored.reduce(
    (best, other) => (other === top ? best : Math.max(best, other.score)),
    0
  );
  const { item } = top.entry;
  if (
    top.score >= MANGA_TITLE_HIGH_SCORE &&
    top.score - runnerUp >= MANGA_TITLE_HIGH_MARGIN &&
    (top.verdict === 'clear' || top.verdict === 'mal') &&
    !proposedElsewhere.has(naturalKey(item.sourceId, item.url))
  ) {
    return {
      kind: 'bind',
      entry: top.entry,
      confidence: MangaBindingConfidence.HIGH,
      matchedBy: MANGA_MATCHED_BY_TITLE,
    };
  }
  return {
    kind: 'unconfirmed',
    proposals: likely.map(({ entry, score }) => ({ entry, score })),
  };
};

/**
 * Offers each entry to an admin as a match for the title, under the
 * instance's admission: a new review row, or a proposal on a row that has
 * none. An entry bound meanwhile, or proposed for another title, is left
 * as it is.
 */
export const proposeMangaLibraryMatches = (
  snapshot: SuwayomiSettings,
  anilistId: number,
  proposals: readonly MangaLibraryProposal[],
  signal: AbortSignal
): Promise<void> =>
  runWithSuwayomiInstanceAdmission(snapshot, () =>
    dataSource.transaction(async (manager) => {
      signal.throwIfAborted();
      const now = new Date();
      for (const { entry, score } of proposals) {
        const { item, suwayomiMangaId } = entry;
        const where = {
          instanceId: snapshot.id,
          sourceId: item.sourceId,
          urlHash: hashMangaSourceUrl(item.url),
        };
        const live = (await manager.find(MangaSourceBinding, { where })).some(
          (row) =>
            row.url === item.url && row.state !== MangaBindingState.REJECTED
        );
        if (live) continue;
        const proposal = {
          proposedAnilistId: anilistId,
          proposalConfidence: confidenceOf(score),
          proposalScore: score,
          titleCheckedAt: now,
        };
        const candidate = await manager.findOneBy(MangaMatchCandidate, where);
        if (!candidate) {
          await manager.insert(MangaMatchCandidate, {
            ...where,
            url: item.url,
            suwayomiMangaId,
            title: item.title,
            ...proposal,
          });
        } else if (
          candidate.url === item.url &&
          candidate.proposedAnilistId === null
        ) {
          await manager.update(MangaMatchCandidate, candidate.id, {
            ...proposal,
            suwayomiMangaId,
            title: item.title,
          });
        }
      }
    })
  );

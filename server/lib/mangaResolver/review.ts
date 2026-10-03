import type SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import type { SuwayomiMangaDetails } from '@server/api/suwayomi/types';
import dataSource from '@server/datasource';
import MangaSourceBinding, {
  MANGA_MATCHED_BY_MANGADEX_LINK,
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import MangaSourceCandidate from '@server/entity/MangaSourceCandidate';
import MangaSourceResolution, {
  MangaResolutionStatus,
} from '@server/entity/MangaSourceResolution';
import { runWithRequestAdmission } from '@server/entity/MediaRequest';
import type { MangaLibraryBinding } from '@server/interfaces/api/mangaLibraryInterfaces';
import type {
  MangaResolveBindResponse,
  MangaResolveCandidate,
  MangaResolveDetail,
  MangaResolveFailure,
  MangaResolveListStatus,
  MangaResolveReason,
  MangaResolveTitle,
  MangaResolveTitlesResponse,
} from '@server/interfaces/api/mangaResolveInterfaces';
import {
  linkMangaLibraryItem,
  readMangaLibraryItem,
} from '@server/lib/mangaLibraryReview';
import { getMangaAdmissionKey } from '@server/lib/mangaMedia';
import { writeMangaResolverBinding } from '@server/lib/mangaResolver/bind';
import {
  MangaResolveError,
  asMangaResolveError,
} from '@server/lib/mangaResolver/errors';
import {
  findWaitingMangaTitles,
  loadMangaResolutions,
  requestMangaTitleSearch,
  resolutionKey,
  type WaitingMangaTitle,
} from '@server/lib/mangaResolver/titles';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import { snapshotSuwayomiInstance } from '@server/lib/suwayomi/instanceAdmission';
import { In, type EntityManager } from 'typeorm';

const MAX_INT32 = 2_147_483_647;

const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

const bindingView = (row: MangaSourceBinding): MangaLibraryBinding => ({
  id: row.id,
  instanceId: row.instanceId,
  sourceId: row.sourceId,
  url: row.url,
  suwayomiMangaId: row.suwayomiMangaId,
  title: row.title,
  anilistId: row.anilistId,
  confidence: row.confidence,
  matchedBy: row.matchedBy,
  origin: row.origin,
  state: row.state,
  inLibrary: row.inLibrary,
  availability: row.availability,
  chapterCount: row.chapterCount,
  downloadCount: row.downloadCount,
  updatedAt: new Date(row.updatedAt).toISOString(),
});

const candidateView = (row: MangaSourceCandidate): MangaResolveCandidate => ({
  id: row.id,
  sourceId: row.sourceId,
  sourceName: row.sourceName,
  sourceLang: row.sourceLang,
  url: row.url,
  suwayomiMangaId: row.suwayomiMangaId,
  title: row.title,
  inLibrary: row.inLibrary,
  score: row.score / 1000,
  confidence: row.confidence as MangaResolveCandidate['confidence'],
  matchedBy: row.matchedBy,
  createdAt: new Date(row.createdAt).toISOString(),
});

/**
 * A waiting title without a result shows as QUEUED, or as awaiting approval
 * while only pending requests wait and no admin search is pending; a bound
 * title as BOUND.
 */
const titleView = (
  title: WaitingMangaTitle,
  row: MangaSourceResolution | undefined,
  candidateCount: number
): MangaResolveTitle => {
  let status: MangaResolveListStatus;
  // The resolver writes only codes from these lists.
  let reason = (row?.reason ?? null) as MangaResolveReason | null;
  if (!title.waiting) {
    status = MangaResolutionStatus.BOUND;
    if (row?.status !== MangaResolutionStatus.BOUND) {
      reason = 'EXISTING_BINDING';
    }
  } else if (
    row &&
    row.status !== MangaResolutionStatus.BOUND &&
    row.status !== MangaResolutionStatus.QUEUED
  ) {
    status = row.status;
  } else {
    status =
      title.approved || row?.searchRequestedAt
        ? MangaResolutionStatus.QUEUED
        : 'AWAITING_APPROVAL';
    reason = null;
  }
  return {
    anilistId: title.anilistId,
    instanceId: title.instanceId,
    status,
    reason,
    mangadexUuid: row?.mangadexUuid ?? null,
    approved: title.approved,
    requestId: title.requestId,
    candidateCount,
    attempts: row?.attempts ?? 0,
    checkedAt: iso(row?.checkedAt ?? null),
    searchedAt: iso(row?.searchedAt ?? null),
    nextAttemptAt: iso(row?.nextAttemptAt ?? null),
    searchRequestedAt: iso(row?.searchRequestedAt ?? null),
    lastError: (row?.lastError ?? null) as MangaResolveFailure | null,
  };
};

const pageInfo = (take: number, skip: number, results: number) => ({
  page: Math.ceil(skip / take) + 1,
  pages: Math.ceil(results / take),
  pageSize: take,
  results,
});

const countCandidates = async (
  manager: EntityManager,
  titles: readonly WaitingMangaTitle[]
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  if (titles.length === 0) return counts;
  const rows = await manager
    .createQueryBuilder(MangaSourceCandidate, 'candidate')
    .select('candidate.instanceId', 'instanceId')
    .addSelect('candidate.anilistId', 'anilistId')
    .addSelect('COUNT(*)', 'count')
    .where('candidate.anilistId IN (:...ids)', {
      ids: [...new Set(titles.map(({ anilistId }) => anilistId))],
    })
    .groupBy('candidate.instanceId')
    .addGroupBy('candidate.anilistId')
    .getRawMany<{ instanceId: unknown; anilistId: unknown; count: unknown }>();
  for (const row of rows) {
    counts.set(
      resolutionKey(Number(row.instanceId), Number(row.anilistId)),
      Number(row.count)
    );
  }
  return counts;
};

/** Titles whose requests wait for a binding, oldest request first. */
export const listMangaResolveTitles = async ({
  status,
  take,
  skip,
}: {
  status?: MangaResolveListStatus;
  take: number;
  skip: number;
}): Promise<MangaResolveTitlesResponse> => {
  const { manager } = dataSource;
  const waiting = await findWaitingMangaTitles(manager);
  const rows = await loadMangaResolutions(manager, waiting);
  const rowOf = (title: WaitingMangaTitle) =>
    rows.get(resolutionKey(title.instanceId, title.anilistId));
  const matching = waiting
    .map((title) => ({ title, view: titleView(title, rowOf(title), 0) }))
    .filter(({ view }) => status === undefined || view.status === status);
  const page = matching.slice(skip, skip + take);
  const counts = await countCandidates(
    manager,
    page.map(({ title }) => title)
  );
  return {
    pageInfo: pageInfo(take, skip, matching.length),
    results: page.map(({ title, view }) => ({
      ...view,
      candidateCount:
        counts.get(resolutionKey(title.instanceId, title.anilistId)) ?? 0,
    })),
  };
};

/** The title's open requests on the instance, in any binding state. */
const findTitle = async (
  manager: EntityManager,
  instanceId: number,
  anilistId: number
): Promise<WaitingMangaTitle> => {
  const [title] = await findWaitingMangaTitles(manager, {
    instanceId,
    anilistId,
    bound: true,
  });
  if (!title) throw new MangaResolveError('MANGA_RESOLVE_TITLE_NOT_FOUND');
  return title;
};

const loadView = async (
  manager: EntityManager,
  title: WaitingMangaTitle
): Promise<MangaResolveTitle> => {
  const rows = await loadMangaResolutions(manager, [title]);
  const counts = await countCandidates(manager, [title]);
  const key = resolutionKey(title.instanceId, title.anilistId);
  return titleView(title, rows.get(key), counts.get(key) ?? 0);
};

/** The title's status, candidates and live bindings on the instance. */
export const getMangaResolveDetail = async (
  instanceId: number,
  anilistId: number
): Promise<MangaResolveDetail> => {
  const { manager } = dataSource;
  const title = await findTitle(manager, instanceId, anilistId);
  const candidates = await manager.find(MangaSourceCandidate, {
    where: { instanceId, anilistId },
    order: { score: 'DESC', id: 'ASC' },
  });
  const bindings = await manager.find(MangaSourceBinding, {
    where: {
      instanceId,
      anilistId,
      state: In([MangaBindingState.ACTIVE, MangaBindingState.ORPHANED]),
    },
    order: { id: 'ASC' },
  });
  const exactFirst = [
    ...candidates.filter(
      (row) => row.confidence === MangaBindingConfidence.EXACT_LINK
    ),
    ...candidates.filter(
      (row) => row.confidence !== MangaBindingConfidence.EXACT_LINK
    ),
  ];
  return {
    ...(await loadView(manager, title)),
    candidates: exactFirst.map(candidateView),
    bindings: bindings.map(bindingView),
  };
};

const findSnapshot = (instanceId: number): SuwayomiSettings => {
  const snapshot = snapshotSuwayomiInstance(instanceId);
  if (!snapshot) throw new MangaResolveError('MANGA_INSTANCE_NOT_FOUND');
  return snapshot;
};

/**
 * Makes a waiting title due at once with a fresh backoff, as
 * `requestMangaTitleSearch` does, after checking the title and the instance.
 */
export const requestMangaResolveSearch = async (
  instanceId: number,
  anilistId: number
): Promise<MangaResolveTitle> => {
  await findTitle(dataSource.manager, instanceId, anilistId);
  findSnapshot(instanceId);
  await requestMangaTitleSearch(instanceId, anilistId);
  return loadView(
    dataSource.manager,
    await findTitle(dataSource.manager, instanceId, anilistId)
  );
};

export type MangaResolveLookup =
  { suwayomiMangaId: number } | { sourceId: string; url: string };

const assertAllowed = (snapshot: SuwayomiSettings, sourceId: string) => {
  if (sourceId === '0' || !snapshot.sourceAllowlist.includes(sourceId)) {
    throw new MangaResolveError('MANGA_SOURCE_NOT_ALLOWED');
  }
};

/** Reads the item from Suwayomi; undefined when Suwayomi doesn't know it. */
const readItem = async (
  instanceId: number,
  lookup: MangaResolveLookup,
  signal: AbortSignal
): Promise<SuwayomiMangaDetails | undefined> => {
  try {
    const client: SuwayomiAPI | undefined = getSuwayomiClient(instanceId);
    if (!client) throw new MangaResolveError('MANGA_INSTANCE_NOT_FOUND');
    const capabilities = await client.getCapabilities({ signal });
    if (!capabilities.supported || capabilities.perUserDownloadState) {
      throw new MangaResolveError('MANGA_UNSUPPORTED_SERVER');
    }
    const details =
      'suwayomiMangaId' in lookup
        ? await client
            .getMangaDetails(String(lookup.suwayomiMangaId), { signal })
            .catch((error: unknown) => {
              if (error instanceof SuwayomiError && error.code === 'NOT_FOUND')
                return undefined;
              throw error;
            })
        : await client.findMangaByNaturalKey(lookup.sourceId, lookup.url, {
            signal,
          });
    if (
      details &&
      !(Number(details.id) >= 1 && Number(details.id) <= MAX_INT32)
    ) {
      throw new SuwayomiError('BAD_RESPONSE', 'MangaDetails');
    }
    return details;
  } catch (error) {
    if (!(error instanceof SuwayomiError)) throw error;
    throw new MangaResolveError('MANGA_SUWAYOMI_LOOKUP_FAILED', error.code);
  }
};

/** Writes the binding after every outside read; the title's status follows. */
type Apply = () => Promise<MangaResolveBindResponse>;

const markBound = (instanceId: number, anilistId: number) =>
  runWithRequestAdmission([getMangaAdmissionKey(anilistId)], () =>
    dataSource.transaction(async (manager) => {
      const row =
        (await manager.findOneBy(MangaSourceResolution, {
          instanceId,
          anilistId,
        })) ?? new MangaSourceResolution({ instanceId, anilistId });
      row.status = MangaResolutionStatus.BOUND;
      row.reason = 'ADMIN_BIND';
      row.attempts = 0;
      row.nextAttemptAt = null;
      row.lastError = null;
      row.searchRequestedAt = null;
      row.checkedAt = new Date();
      await manager.save(row);
    })
  );

const respond = async (
  instanceId: number,
  anilistId: number,
  outcome: MangaResolveBindResponse['outcome'],
  binding: MangaLibraryBinding
): Promise<MangaResolveBindResponse> => {
  await markBound(instanceId, anilistId);
  return {
    outcome,
    binding,
    title: await loadView(
      dataSource.manager,
      await findTitle(dataSource.manager, instanceId, anilistId)
    ),
  };
};

/**
 * Prepares a bind of the item to the title. An item in the Suwayomi library
 * goes through the library review's link, which the library scan keeps up to
 * date; any other item becomes an ACTIVE binding outside the library.
 */
const prepareBind = async (
  snapshot: SuwayomiSettings,
  anilistId: number,
  details: SuwayomiMangaDetails,
  exact: boolean,
  signal: AbortSignal
): Promise<Apply> => {
  const instanceId = snapshot.id;
  if (details.inLibrary) {
    const read = await readMangaLibraryItem(
      instanceId,
      { suwayomiMangaId: Number(details.id) },
      signal
    ).catch((error: unknown) => {
      throw asMangaResolveError(error);
    });
    if (read.liveAnilistId !== undefined && read.liveAnilistId !== anilistId) {
      throw new MangaResolveError('MANGA_ITEM_BOUND_ELSEWHERE');
    }
    return async () => {
      const urlHash = hashMangaSourceUrl(read.url);
      const active = (
        await dataSource.manager.find(MangaSourceBinding, {
          where: {
            instanceId,
            sourceId: read.sourceId,
            urlHash,
            anilistId,
            state: MangaBindingState.ACTIVE,
          },
        })
      ).find((row) => row.url === read.url);
      if (active) {
        return respond(instanceId, anilistId, 'unchanged', bindingView(active));
      }
      const state = await linkMangaLibraryItem(read, { anilistId }).catch(
        (error: unknown) => {
          throw asMangaResolveError(error);
        }
      );
      if (!state.binding || state.binding.anilistId !== anilistId) {
        throw new MangaResolveError('MANGA_ITEM_CHANGED');
      }
      return respond(instanceId, anilistId, 'bound', state.binding);
    };
  }
  const title = details.title.replace(/[\uD800-\uDBFF]$/, '').trim();
  return async () => {
    const result = await writeMangaResolverBinding(
      {
        snapshot,
        anilistId,
        sourceId: details.sourceId,
        url: details.url,
        suwayomiMangaId: Number(details.id),
        title,
        exact,
      },
      'admin'
    );
    // An admin write is never skipped; it fails instead.
    if (result.outcome === 'skipped') {
      throw new MangaResolveError('MANGA_ITEM_CHANGED');
    }
    return respond(
      instanceId,
      anilistId,
      result.outcome,
      bindingView(result.binding)
    );
  };
};

/**
 * Binds a candidate the resolver found. Suwayomi must still know the item;
 * an exact-link candidate keeps its MangaDex credit.
 */
export const prepareMangaResolveSelect = async (
  anilistId: number,
  { instanceId, candidateId }: { instanceId: number; candidateId: number },
  signal: AbortSignal
): Promise<Apply> => {
  await findTitle(dataSource.manager, instanceId, anilistId);
  const candidate = await dataSource.manager.findOneBy(MangaSourceCandidate, {
    id: candidateId,
    instanceId,
    anilistId,
  });
  if (!candidate) throw new MangaResolveError('MANGA_CANDIDATE_NOT_FOUND');
  const snapshot = findSnapshot(instanceId);
  assertAllowed(snapshot, candidate.sourceId);
  const details = await readItem(
    instanceId,
    { sourceId: candidate.sourceId, url: candidate.url },
    signal
  );
  if (!details) throw new MangaResolveError('MANGA_CANDIDATE_GONE');
  const exact =
    candidate.confidence === MangaBindingConfidence.EXACT_LINK &&
    candidate.matchedBy === MANGA_MATCHED_BY_MANGADEX_LINK;
  return prepareBind(snapshot, anilistId, details, exact, signal);
};

/** Binds a source manga the admin names; Suwayomi must already know it. */
export const prepareMangaResolveBind = async (
  anilistId: number,
  { instanceId, ...lookup }: { instanceId: number } & MangaResolveLookup,
  signal: AbortSignal
): Promise<Apply> => {
  await findTitle(dataSource.manager, instanceId, anilistId);
  const snapshot = findSnapshot(instanceId);
  if ('sourceId' in lookup) assertAllowed(snapshot, lookup.sourceId);
  const details = await readItem(instanceId, lookup, signal);
  if (!details) throw new MangaResolveError('MANGA_ITEM_NOT_FOUND');
  assertAllowed(snapshot, details.sourceId);
  return prepareBind(snapshot, anilistId, details, false, signal);
};

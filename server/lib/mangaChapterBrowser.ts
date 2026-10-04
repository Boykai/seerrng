import type SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import type { SuwayomiChapter } from '@server/api/suwayomi/types';
import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import type {
  MangaChapterPageResponse,
  MangaChapterResult,
  MangaChapterStatus,
} from '@server/interfaces/api/mangaChapterInterfaces';
import cacheManager from '@server/lib/cache';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { getMangaDownloadErrorFields } from '@server/lib/mangaDownloadCopy';
import {
  isKnownMangaChapterNumber,
  selectMangaManifestChapters,
} from '@server/lib/mangaRequests';
import { getMangaDownloadAssetId } from '@server/lib/requestDownloadAssets';
import {
  getRequestStatus,
  offersRequestDownloads,
} from '@server/lib/requestStatus';
import { getSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import { chunk } from '@server/utils/chunk';
import { getHttpErrorDetails } from '@server/utils/httpError';
import { In, type FindOptionsSelect } from 'typeorm';

export const MAX_MANGA_CHAPTER_PAGE = 10_000;
export const MAX_MANGA_CHAPTER_PAGE_SIZE = 100;
export const DEFAULT_MANGA_CHAPTER_PAGE_SIZE = 50;
/** Library entries one view may look up; a missing entry is cached too. */
const MAX_BINDING_LOOKUPS = 5;
const ID_SLICE = 500;

/** A chapter as Suwayomi stores it. Server-only: never sent to a browser. */
interface StoredChapter {
  url: string;
  urlHash: string;
  /** -1 when unknown, as Suwayomi reports it. */
  chapterNumber: number;
  name: string;
  /** Epoch milliseconds, or null when unknown. */
  uploadDate: number | null;
  sourceOrder: number;
  isDownloaded: boolean;
  scanlator: string | null;
}

/** Null when Suwayomi no longer has the manga. */
interface CachedChapters {
  chapters: StoredChapter[] | null;
}

/** The library entry a view reads, with its chapters in display order. */
interface BrowsedManga {
  instanceId: number;
  sourceId: string;
  urlHash: string;
  chapters: StoredChapter[];
}

export interface MangaChapterViewer {
  id: number;
  /** MANAGE_REQUESTS or REQUEST_VIEW: every request counts, not only own. */
  canViewAll: boolean;
}

export interface MangaChapterPaging {
  page: number;
  pageSize: number;
}

const loading = new Map<string, Promise<CachedChapters>>();

const parseBoundedInteger = (
  value: unknown,
  max: number,
  fallback: number
): number | undefined => {
  if (value === undefined) return fallback;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,9}$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max
    ? parsed
    : undefined;
};

/** `page` and `pageSize` exactly as given; out of range is an error. */
export const parseMangaChapterPaging = (query: {
  page?: unknown;
  pageSize?: unknown;
}): MangaChapterPaging | { error: string } => {
  const page = parseBoundedInteger(query.page, MAX_MANGA_CHAPTER_PAGE, 1);
  if (page === undefined) {
    return {
      error: `page must be an integer from 1 to ${MAX_MANGA_CHAPTER_PAGE}.`,
    };
  }
  const pageSize = parseBoundedInteger(
    query.pageSize,
    MAX_MANGA_CHAPTER_PAGE_SIZE,
    DEFAULT_MANGA_CHAPTER_PAGE_SIZE
  );
  if (pageSize === undefined) {
    return {
      error: `pageSize must be an integer from 1 to ${MAX_MANGA_CHAPTER_PAGE_SIZE}.`,
    };
  }
  return { page, pageSize };
};

/** Log fields for a failure: codes and names only, never a message. */
export const getMangaChapterErrorFields = (
  error: unknown
): Record<string, string | number> => {
  const fields = getMangaDownloadErrorFields(error);
  if (error instanceof SuwayomiError) return fields;
  const { errorCode, status } = getHttpErrorDetails(error);
  return {
    ...fields,
    ...(errorCode !== undefined && { errorCode }),
    ...(status !== undefined && { status }),
  };
};

const toStoredChapter = (chapter: SuwayomiChapter): StoredChapter => {
  const uploadDate =
    chapter.uploadDate === undefined ? Number.NaN : Number(chapter.uploadDate);
  return {
    url: chapter.url,
    urlHash: hashMangaSourceUrl(chapter.url),
    chapterNumber: chapter.chapterNumber,
    // A name cut at its length limit must not end in half a character.
    name: chapter.name.replace(/[\ud800-\udbff]$/, ''),
    uploadDate: Number.isFinite(uploadDate) ? uploadDate : null,
    sourceOrder: chapter.sourceOrder,
    isDownloaded: chapter.isDownloaded,
    scanlator: chapter.scanlator ?? null,
  };
};

/** Highest number first, unknown numbers last, then Suwayomi's own order. */
const compareChapters = (a: StoredChapter, b: StoredChapter): number => {
  const left = isKnownMangaChapterNumber(a.chapterNumber)
    ? a.chapterNumber
    : -1;
  const right = isKnownMangaChapterNumber(b.chapterNumber)
    ? b.chapterNumber
    : -1;
  return (
    right - left ||
    b.sourceOrder - a.sourceOrder ||
    (a.urlHash < b.urlHash ? -1 : a.urlHash > b.urlHash ? 1 : 0)
  );
};

/**
 * Reads what Suwayomi stores for the manga. Only lookups by natural key and
 * stored chapter lists: nothing here makes Suwayomi contact a source.
 */
const readChapters = async (
  client: SuwayomiAPI,
  binding: Pick<MangaSourceBinding, 'sourceId' | 'url' | 'urlHash'>
): Promise<CachedChapters> => {
  const found = await client.findMangaByNaturalKey(
    binding.sourceId,
    binding.url
  );
  if (
    !found ||
    found.sourceId !== binding.sourceId ||
    hashMangaSourceUrl(found.url) !== binding.urlHash
  ) {
    return { chapters: null };
  }
  const [toDownload, downloaded] = await Promise.all([
    client.getChaptersToDownload(found.id),
    client.getDownloadedChapters(found.id),
  ]);
  const byId = new Map<string, SuwayomiChapter>();
  for (const chapter of [...toDownload, ...downloaded]) {
    byId.set(chapter.id, chapter);
  }
  return {
    chapters: [...byId.values()].map(toStoredChapter).sort(compareChapters),
  };
};

/** One Suwayomi read per library entry at a time; failures are not cached. */
const loadChapters = (
  instanceId: number,
  binding: Pick<MangaSourceBinding, 'sourceId' | 'url' | 'urlHash'>
): Promise<CachedChapters> => {
  const key = `${instanceId}:${binding.sourceId}:${binding.urlHash}`;
  const cache = cacheManager.getCache('suwayomichapters').data;
  const cached = cache.get<CachedChapters>(key);
  if (cached) return Promise.resolve(cached);
  const pending = loading.get(key);
  if (pending) return pending;
  const client = getSuwayomiClient(instanceId);
  if (!client) return Promise.resolve({ chapters: null });
  const load = readChapters(client, binding)
    .then((value) => {
      cache.set(key, value);
      return value;
    })
    .finally(() => loading.delete(key));
  loading.set(key, load);
  return load;
};

/**
 * The first library entry of the title that Suwayomi still has: entries on
 * the default instance first, then by instance and binding ID.
 */
const findBrowsedManga = async (
  anilistId: number
): Promise<BrowsedManga | undefined> => {
  const instances = getExternalRuntimeConfig().suwayomi;
  const rankOf = (instanceId: number) =>
    instances.find((instance) => instance.id === instanceId)?.isDefault ? 0 : 1;
  const bindings = (
    await getRepository(MangaSourceBinding).find({
      where: { anilistId, state: MangaBindingState.ACTIVE, inLibrary: true },
    })
  )
    .filter((binding) =>
      instances.some((instance) => instance.id === binding.instanceId)
    )
    .sort(
      (a, b) =>
        rankOf(a.instanceId) - rankOf(b.instanceId) ||
        a.instanceId - b.instanceId ||
        a.id - b.id
    )
    .slice(0, MAX_BINDING_LOOKUPS);
  for (const binding of bindings) {
    const { chapters } = await loadChapters(binding.instanceId, binding);
    if (chapters) {
      return {
        instanceId: binding.instanceId,
        sourceId: binding.sourceId,
        urlHash: binding.urlHash,
        chapters,
      };
    }
  }
  return undefined;
};

/** Manga requests for the title the viewer may see; declined ones never. */
const loadVisibleManifests = (
  anilistId: number,
  viewer: MangaChapterViewer
): Promise<MangaRequestManifest[]> => {
  const query = getRepository(MangaRequestManifest)
    .createQueryBuilder('manifest')
    .innerJoinAndSelect('manifest.request', 'request')
    .innerJoinAndSelect('request.media', 'media')
    .where('manifest.anilistId = :anilistId', { anilistId })
    .andWhere('request.type = :type', { type: MediaType.MANGA })
    .andWhere('request.status != :declined', {
      declined: MediaRequestStatus.DECLINED,
    });
  if (!viewer.canViewAll) {
    query.andWhere('request.requestedById = :viewerId', {
      viewerId: viewer.id,
    });
  }
  return query.orderBy('manifest.id', 'ASC').getMany();
};

const pageInfoOf = ({ page, pageSize }: MangaChapterPaging, total: number) => ({
  page,
  pages: Math.max(1, Math.ceil(total / pageSize)),
  pageSize,
  results: total,
});

const toIsoDate = (value: number | null): string | null => {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Without a library entry, the chapters the viewer's visible requests hold:
 * every one requested, each known number once, without names or dates.
 */
const getRequestedChapterPage = async (
  manifests: readonly MangaRequestManifest[],
  paging: MangaChapterPaging
): Promise<MangaChapterPageResponse> => {
  const numbers = new Map<string, number | null>();
  const frozenIds = manifests
    .filter((manifest) => manifest.frozenAt !== null)
    .map((manifest) => manifest.id);
  for (const ids of chunk(frozenIds, ID_SLICE)) {
    const rows = await getRepository(MangaRequestChapter).find({
      select: { urlHash: true, chapterNumber: true },
      where: { manifestId: In(ids) },
    });
    for (const { urlHash, chapterNumber } of rows) {
      if ((numbers.get(urlHash) ?? null) === null) {
        numbers.set(
          urlHash,
          isKnownMangaChapterNumber(chapterNumber) ? chapterNumber : null
        );
      }
    }
  }
  const values = [...numbers.values()];
  const chapters: (number | null)[] = [
    ...[...new Set(values.filter(isKnownMangaChapterNumber))].sort(
      (a, b) => b - a
    ),
    ...values.filter((value) => value === null),
  ];
  const start = (paging.page - 1) * paging.pageSize;
  return {
    pageInfo: pageInfoOf(paging, chapters.length),
    inLibrary: false,
    results: chapters
      .slice(start, start + paging.pageSize)
      .map((number): MangaChapterResult => ({
        number,
        name: '',
        uploadedAt: null,
        status: 'requested',
      })),
  };
};

/**
 * Whether the manifest's request offers its verified chapters under the
 * download route's own rules: a bound manifest, a server that serves CBZ
 * archives and a stage that offers copies.
 */
const offersChapterCopies = (manifest: MangaRequestManifest): boolean => {
  if (manifest.bindingState !== MangaRequestBindingState.BOUND) return false;
  const instance = getExternalRuntimeConfig().suwayomi.find(
    (entry) => entry.id === manifest.instanceId
  );
  if (instance?.requireCbz !== true) return false;
  const { stage } = getRequestStatus(manifest.request, {
    mangaProgress: manifest,
    downloads: [],
  });
  return offersRequestDownloads(manifest.request, stage);
};

const chapterRowSelect: FindOptionsSelect<MangaRequestChapter> = {
  manifestId: true,
  urlHash: true,
  chapterNumber: true,
  deliverableAt: true,
  missingSince: true,
};

/** A page of the library entry's chapters with the viewer's state of each. */
const getLibraryChapterPage = async (
  browsed: BrowsedManga,
  manifests: readonly MangaRequestManifest[],
  paging: MangaChapterPaging
): Promise<MangaChapterPageResponse> => {
  const start = (paging.page - 1) * paging.pageSize;
  const rows = browsed.chapters.slice(start, start + paging.pageSize);
  const isSameKey = (manifest: MangaRequestManifest) =>
    manifest.instanceId === browsed.instanceId &&
    manifest.bindingSourceId === browsed.sourceId &&
    manifest.bindingUrlHash === browsed.urlHash;
  const frozen = manifests.filter((manifest) => manifest.frozenAt !== null);
  const sameKeyIds = frozen.filter(isSameKey).map(({ id }) => id);
  const otherIds = frozen
    .filter((manifest) => !isSameKey(manifest))
    .map(({ id }) => id);
  const hashes = [...new Set(rows.map(({ urlHash }) => urlHash))];
  const numbers = [
    ...new Set(
      rows
        .map(({ chapterNumber }) => chapterNumber)
        .filter(isKnownMangaChapterNumber)
    ),
  ];

  const repository = getRepository(MangaRequestChapter);
  const requestRows: MangaRequestChapter[] = [];
  if (hashes.length > 0) {
    for (const ids of chunk(sameKeyIds, ID_SLICE)) {
      requestRows.push(
        ...(await repository.find({
          select: chapterRowSelect,
          where: { manifestId: In(ids), urlHash: In(hashes) },
        }))
      );
    }
  }
  if (numbers.length > 0) {
    for (const ids of chunk(otherIds, ID_SLICE)) {
      requestRows.push(
        ...(await repository.find({
          select: chapterRowSelect,
          where: { manifestId: In(ids), chapterNumber: In(numbers) },
        }))
      );
    }
  }

  const manifestById = new Map(manifests.map((entry) => [entry.id, entry]));
  const copies = new Map<number, boolean>();
  const offersCopies = (manifest: MangaRequestManifest) => {
    let offers = copies.get(manifest.id);
    if (offers === undefined) {
      offers = offersChapterCopies(manifest);
      copies.set(manifest.id, offers);
    }
    return offers;
  };
  const requestedHashes = new Set<string>();
  const requestedNumbers = new Set<number>();
  // The newest request offering each verified chapter.
  const copyRequests = new Map<string, MangaRequestManifest>();
  for (const row of requestRows) {
    const manifest = manifestById.get(row.manifestId);
    if (!manifest) continue;
    if (!isSameKey(manifest)) {
      if (isKnownMangaChapterNumber(row.chapterNumber)) {
        requestedNumbers.add(row.chapterNumber);
      }
      continue;
    }
    requestedHashes.add(row.urlHash);
    const current = copyRequests.get(row.urlHash);
    if (
      row.deliverableAt !== null &&
      row.missingSince === null &&
      (!current || current.requestId < manifest.requestId) &&
      offersCopies(manifest)
    ) {
      copyRequests.set(row.urlHash, manifest);
    }
  }

  // Requests that have not picked their chapters yet: the ones dispatch
  // would pick from this list now.
  const previewUrls = new Set<string>();
  const unfrozen = manifests.filter((manifest) => manifest.frozenAt === null);
  if (unfrozen.length > 0) {
    const instances = getExternalRuntimeConfig().suwayomi;
    for (const manifest of unfrozen) {
      const preference =
        instances.find((instance) => instance.id === manifest.instanceId)
          ?.scanlatorPreference ?? [];
      for (const { url } of selectMangaManifestChapters(
        manifest,
        browsed.chapters,
        preference
      )) {
        previewUrls.add(url);
      }
    }
  }

  const statusOf = (chapter: StoredChapter): MangaChapterStatus => {
    if (chapter.isDownloaded) return 'available';
    return requestedHashes.has(chapter.urlHash) ||
      previewUrls.has(chapter.url) ||
      (isKnownMangaChapterNumber(chapter.chapterNumber) &&
        requestedNumbers.has(chapter.chapterNumber))
      ? 'requested'
      : 'notRequested';
  };

  return {
    pageInfo: pageInfoOf(paging, browsed.chapters.length),
    inLibrary: true,
    results: rows.map((chapter): MangaChapterResult => {
      const status = statusOf(chapter);
      const copy =
        status === 'available' ? copyRequests.get(chapter.urlHash) : undefined;
      return {
        number: isKnownMangaChapterNumber(chapter.chapterNumber)
          ? chapter.chapterNumber
          : null,
        name: chapter.name,
        uploadedAt: toIsoDate(chapter.uploadDate),
        status,
        ...(copy && {
          download: {
            requestId: copy.requestId,
            assetId: getMangaDownloadAssetId(copy.requestId, {
              instanceId: copy.instanceId,
              urlHash: chapter.urlHash,
            }),
          },
        }),
      };
    }),
  };
};

/**
 * A page of a title's chapters as SeerrNG and Suwayomi already store them.
 * Never makes Suwayomi contact a source and never writes. The caller checks
 * that the title exists and may be shown.
 */
export const getMangaChapterPage = async (
  anilistId: number,
  viewer: MangaChapterViewer,
  paging: MangaChapterPaging
): Promise<MangaChapterPageResponse> => {
  const browsed = await findBrowsedManga(anilistId);
  const manifests = await loadVisibleManifests(anilistId, viewer);
  return browsed
    ? getLibraryChapterPage(browsed, manifests, paging)
    : getRequestedChapterPage(manifests, paging);
};

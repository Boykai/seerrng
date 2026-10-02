import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import Tvdb from '@server/api/tvdb';
import type { TvdbVideoMetadataRecord } from '@server/api/tvdb/interfaces';
import TvmazeAPI, { type TvmazeShow } from '@server/api/tvmaze';
import WikidataVideoMetadataAPI, {
  type WikidataVideoMetadata,
} from '@server/api/wikidata/videoMetadata';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaSearchMetadata } from '@server/entity/MediaSearchMetadata';
import {
  VideoMetadataSource,
  VideoMetadataSourceRecord,
  type VideoMetadataMediaType,
} from '@server/entity/VideoMetadataSourceRecord';
import type { MetadataSettings } from '@server/lib/settings';
import { getSettings, MetadataProviderType } from '@server/lib/settings';
import logger from '@server/logger';
import type {
  VideoMetadataAttribution,
  VideoMetadataProvenance,
  VideoMetadataSourceName,
} from '@server/models/VideoMetadata';
import { Brackets, LessThanOrEqual } from 'typeorm';

export interface VideoMetadataFields {
  title?: string;
  originalTitle?: string;
  overview?: string;
  releaseDate?: string;
  genres: string[];
  runtime?: number;
  status?: string;
  studios: string[];
  networks: string[];
  directors: string[];
  writers: string[];
  imdbId?: string;
  tvdbId?: number;
  tvmazeId?: number;
  wikidataId?: string;
  tmdbId?: number;
}

export interface AggregatedMovieMetadata {
  details: TmdbMovieDetails;
  provenance: VideoMetadataProvenance;
}

export interface AggregatedTvMetadata {
  details: TmdbTvDetails;
  provenance: VideoMetadataProvenance;
}

export class VideoMetadataNotFoundError extends Error {
  constructor() {
    super('No cached or provider metadata is available for this title');
    this.name = 'VideoMetadataNotFoundError';
  }
}

interface VideoMetadataIdentity {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  tvmazeId?: number;
  wikidataId?: string;
}

interface NormalizedSnapshot {
  fields: VideoMetadataFields;
  details?: TmdbMovieDetails | TmdbTvDetails;
}

interface SourceDraft extends VideoMetadataIdentity {
  mediaType: VideoMetadataMediaType;
  provider: VideoMetadataSource;
  sourceId: string;
  fields: VideoMetadataFields;
  details?: TmdbMovieDetails | TmdbTvDetails;
  attributionUrl?: string;
}

const SOURCE_REFRESH_AGE_MS: Record<VideoMetadataSource, number> = {
  [VideoMetadataSource.TMDB]: 30 * 24 * 60 * 60 * 1000,
  [VideoMetadataSource.TVDB]: 30 * 24 * 60 * 60 * 1000,
  [VideoMetadataSource.TVMAZE]: 7 * 24 * 60 * 60 * 1000,
  [VideoMetadataSource.WIKIDATA]: 30 * 24 * 60 * 60 * 1000,
};

const errorHasHttpStatus = (error: unknown, status: number): boolean => {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      response?: { status?: unknown };
    };
    if (candidate.response?.status === status) return true;
    current = candidate.cause;
  }
  return false;
};

const getTmdbSnapshotId = (tmdbId: number, language?: string): string =>
  `${tmdbId}:${language?.trim().toLocaleLowerCase() || 'default'}`;

const recordsForLanguage = (
  rows: VideoMetadataSourceRecord[],
  tmdbId: number,
  language?: string
): VideoMetadataSourceRecord[] => {
  const tmdbRows = rows.filter(
    (record) => record.provider === VideoMetadataSource.TMDB
  );
  const exactLocaleRows = tmdbRows.filter(
    (record) => record.sourceId === getTmdbSnapshotId(tmdbId, language)
  );
  const englishLocaleRows = tmdbRows.filter((record) =>
    record.sourceId.startsWith(`${tmdbId}:en-`)
  );
  const defaultLocaleRows = tmdbRows.filter((record) =>
    [`${tmdbId}:en`, `${tmdbId}:default`, String(tmdbId)].includes(
      record.sourceId
    )
  );
  const fallbackRows = language?.trim().toLocaleLowerCase().startsWith('en')
    ? [...defaultLocaleRows, ...englishLocaleRows]
    : defaultLocaleRows;
  const selectedTmdbRows = exactLocaleRows.length
    ? exactLocaleRows
    : fallbackRows;
  return [
    ...rows.filter((record) => record.provider !== VideoMetadataSource.TMDB),
    ...selectedTmdbRows,
  ];
};

const cleanString = (value: unknown, maximum = 4_000): string | undefined =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maximum) || undefined
    : undefined;

const cleanStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Map(
          value
            .map((item) => cleanString(item, 300))
            .filter((item): item is string => !!item)
            .map((item) => [normalizeVideoTitle(item), item])
        ).values(),
      ].slice(0, 50)
    : [];

export const normalizeVideoTitle = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase();

/** Add calendar months without letting Jan 31 overflow past six months. */
export const getVideoMetadataExpiry = (now: Date): Date => {
  const expiry = new Date(now);
  const day = expiry.getUTCDate();
  expiry.setUTCDate(1);
  expiry.setUTCMonth(expiry.getUTCMonth() + 6);
  const lastDay = new Date(
    Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)
  ).getUTCDate();
  expiry.setUTCDate(Math.min(day, lastDay));
  return expiry;
};

const getYear = (value?: string): string | undefined =>
  value?.match(/^(\d{4})/)?.[1];

const isExactSourceMatch = ({
  candidateTitles,
  candidateYear,
  title,
  year,
}: {
  candidateTitles: (string | undefined)[];
  candidateYear?: string;
  title: string;
  year?: string;
}): boolean => {
  const normalizedTitle = normalizeVideoTitle(title);
  if (
    !normalizedTitle ||
    !candidateTitles.some(
      (candidate) =>
        !!candidate && normalizeVideoTitle(candidate) === normalizedTitle
    )
  ) {
    return false;
  }
  return !year || !candidateYear || year === candidateYear;
};

const htmlToText = (value?: string | null): string | undefined => {
  if (!value) {
    return undefined;
  }
  const text = value
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text.slice(0, 4_000) || undefined;
};

const getSourceLink = (
  provider: VideoMetadataSource,
  mediaType: VideoMetadataMediaType,
  ids: VideoMetadataIdentity,
  fallbackId: string
): string => {
  switch (provider) {
    case VideoMetadataSource.TMDB:
      return `https://www.themoviedb.org/${mediaType === 'movie' ? 'movie' : 'tv'}/${ids.tmdbId ?? fallbackId}`;
    case VideoMetadataSource.TVDB:
      return `https://thetvdb.com/dereferrer/${mediaType === 'movie' ? 'movie' : 'series'}/${ids.tvdbId ?? fallbackId}`;
    case VideoMetadataSource.TVMAZE:
      return `https://www.tvmaze.com/shows/${ids.tvmazeId ?? fallbackId}`;
    case VideoMetadataSource.WIKIDATA:
      return `https://www.wikidata.org/wiki/${ids.wikidataId ?? fallbackId}`;
  }
};

const getLicenseLabel = (source: VideoMetadataSource): string | undefined => {
  switch (source) {
    case VideoMetadataSource.TVDB:
      return 'Attribution required';
    case VideoMetadataSource.TVMAZE:
      return 'CC BY-SA 4.0';
    case VideoMetadataSource.WIKIDATA:
      return 'CC0';
    default:
      return undefined;
  }
};

const getLicenseUrl = (source: VideoMetadataSource): string | undefined => {
  switch (source) {
    case VideoMetadataSource.TVDB:
      return 'https://thetvdb.com/tos';
    case VideoMetadataSource.TVMAZE:
      return 'https://creativecommons.org/licenses/by-sa/4.0/';
    case VideoMetadataSource.WIKIDATA:
      return 'https://creativecommons.org/publicdomain/zero/1.0/';
    default:
      return undefined;
  }
};

const getProviderPriority = (
  mediaType: VideoMetadataMediaType,
  settings?: MetadataSettings,
  isAnime = false
): VideoMetadataSource[] =>
  mediaType === 'tv' &&
  (isAnime ? settings?.anime : settings?.tv) === MetadataProviderType.TVDB
    ? [
        VideoMetadataSource.TVDB,
        VideoMetadataSource.TMDB,
        VideoMetadataSource.TVMAZE,
        VideoMetadataSource.WIKIDATA,
      ]
    : [
        VideoMetadataSource.TMDB,
        VideoMetadataSource.TVDB,
        VideoMetadataSource.TVMAZE,
        VideoMetadataSource.WIKIDATA,
      ];

const snapshotFromRecord = (
  row: VideoMetadataSourceRecord
): SourceDraft | undefined => {
  try {
    const parsed = JSON.parse(row.payload) as NormalizedSnapshot;
    if (!parsed || typeof parsed !== 'object' || !parsed.fields) {
      return undefined;
    }
    return {
      mediaType: row.mediaType,
      provider: row.provider,
      sourceId: row.sourceId,
      tmdbId: row.tmdbId ?? undefined,
      tvdbId: row.tvdbId ?? undefined,
      imdbId: row.imdbId ?? undefined,
      tvmazeId: row.tvmazeId ?? undefined,
      wikidataId: row.wikidataId ?? undefined,
      fields: parsed.fields,
      details: parsed.details,
      attributionUrl: row.attributionUrl ?? undefined,
    };
  } catch {
    return undefined;
  }
};

const normalizeTmdbDetails = (
  mediaType: VideoMetadataMediaType,
  details: TmdbMovieDetails | TmdbTvDetails
): VideoMetadataFields => {
  if (mediaType === 'movie') {
    const movie = details as TmdbMovieDetails;
    return {
      title: cleanString(movie.title),
      originalTitle: cleanString(movie.original_title),
      overview: cleanString(movie.overview),
      releaseDate: cleanString(movie.release_date, 32),
      genres: cleanStringList(movie.genres?.map((genre) => genre.name)),
      runtime:
        Number.isFinite(movie.runtime) && Number(movie.runtime) > 0
          ? Number(movie.runtime)
          : undefined,
      status: cleanString(movie.status, 200),
      studios: cleanStringList(
        movie.production_companies?.map((company) => company.name)
      ),
      networks: [],
      directors: cleanStringList(
        movie.credits?.crew
          ?.filter((credit) => credit.job === 'Director')
          .map((credit) => credit.name)
      ),
      writers: cleanStringList(
        movie.credits?.crew
          ?.filter((credit) =>
            ['Writer', 'Screenplay', 'Story', 'Teleplay'].includes(credit.job)
          )
          .map((credit) => credit.name)
      ),
      imdbId: cleanString(movie.imdb_id, 32),
      tvdbId: movie.external_ids?.tvdb_id,
      wikidataId: cleanString(movie.external_ids?.wikidata_id, 32),
      tmdbId: movie.id,
    };
  }

  const series = details as TmdbTvDetails;
  return {
    title: cleanString(series.name),
    originalTitle: cleanString(series.original_name),
    overview: cleanString(series.overview),
    releaseDate: cleanString(series.first_air_date, 32),
    genres: cleanStringList(series.genres?.map((genre) => genre.name)),
    runtime:
      series.episode_run_time?.find(
        (runtime) => Number.isFinite(runtime) && runtime > 0
      ) ?? undefined,
    status: cleanString(series.status, 200),
    studios: cleanStringList(
      series.production_companies?.map((company) => company.name)
    ),
    networks: cleanStringList(series.networks?.map((network) => network.name)),
    directors: cleanStringList(
      series.credits?.crew
        ?.filter((credit) => credit.job === 'Director')
        .map((credit) => credit.name)
    ),
    writers: cleanStringList(
      series.credits?.crew
        ?.filter((credit) =>
          ['Writer', 'Screenplay', 'Story', 'Teleplay'].includes(credit.job)
        )
        .map((credit) => credit.name)
    ),
    imdbId: cleanString(series.external_ids?.imdb_id, 32),
    tvdbId: series.external_ids?.tvdb_id,
    wikidataId: cleanString(series.external_ids?.wikidata_id, 32),
    tmdbId: series.id,
  };
};

const normalizeTvdb = (
  source: TvdbVideoMetadataRecord
): VideoMetadataFields => {
  const remoteIds = Array.isArray(source.remoteIds) ? source.remoteIds : [];
  const getRemote = (name: RegExp) =>
    remoteIds.find((item) => name.test(item.sourceName ?? ''))?.id;
  const tmdbRemote = getRemote(/tmdb|the movie database/i);
  const imdbRemote = getRemote(/imdb/i);
  const tvmazeRemote = getRemote(/tvmaze/i);
  const companies = source.companies;
  const companyNames = [
    ...(companies?.studio ?? []),
    ...(companies?.production ?? []),
  ].map((company) => company.name);
  const networkNames = (companies?.network ?? []).map(
    (company) => company.name
  );
  const firstAired =
    typeof source.firstAired === 'string'
      ? source.firstAired
      : typeof source.releaseDate === 'string'
        ? source.releaseDate
        : undefined;

  return {
    title: cleanString(source.name),
    originalTitle: cleanString(source.name),
    overview: cleanString(source.overview),
    releaseDate: cleanString(firstAired, 32),
    genres: cleanStringList(
      Array.isArray(source.genres)
        ? source.genres.map((genre) => genre.name)
        : []
    ),
    runtime:
      Number(source.averageRuntime ?? source.runtime) > 0
        ? Number(source.averageRuntime ?? source.runtime)
        : undefined,
    status:
      typeof source.status === 'string'
        ? cleanString(source.status, 200)
        : cleanString(source.status?.name, 200),
    studios: cleanStringList(companyNames),
    networks: cleanStringList(networkNames),
    directors: [],
    writers: [],
    tmdbId:
      tmdbRemote && /^\d+$/.test(tmdbRemote) ? Number(tmdbRemote) : undefined,
    tvdbId: source.id,
    imdbId: imdbRemote?.startsWith('tt') ? imdbRemote : undefined,
    tvmazeId:
      tvmazeRemote && /^\d+$/.test(tvmazeRemote)
        ? Number(tvmazeRemote)
        : undefined,
  };
};

const normalizeTvmaze = (source: TvmazeShow): VideoMetadataFields => ({
  title: cleanString(source.name),
  originalTitle: cleanString(source.name),
  overview: htmlToText(source.summary),
  releaseDate: cleanString(source.premiered, 32),
  genres: cleanStringList(source.genres),
  runtime:
    Number(source.averageRuntime ?? source.runtime) > 0
      ? Number(source.averageRuntime ?? source.runtime)
      : undefined,
  status: cleanString(source.status, 200),
  studios: [],
  networks: cleanStringList([source.network?.name, source.webChannel?.name]),
  directors: [],
  writers: [],
  tvdbId: source.externals?.thetvdb ?? undefined,
  imdbId: cleanString(source.externals?.imdb, 32),
  tvmazeId: source.id,
});

const normalizeWikidata = (
  source: WikidataVideoMetadata,
  mediaType: VideoMetadataMediaType
): VideoMetadataFields => ({
  title: cleanString(source.title),
  originalTitle: cleanString(source.title),
  overview: cleanString(source.overview),
  releaseDate: cleanString(source.releaseDate, 32),
  genres: cleanStringList(source.genres),
  runtime: source.runtime,
  status: undefined,
  studios: cleanStringList(source.studios),
  networks: [],
  directors: cleanStringList(source.directors),
  writers: cleanStringList(source.writers),
  tmdbId:
    (mediaType === 'movie' ? source.tmdbMovieId : source.tmdbTvId) ??
    source.tmdbId,
  tvdbId:
    (mediaType === 'movie' ? source.tvdbMovieId : source.tvdbSeriesId) ??
    source.tvdbId,
  imdbId: source.imdbId,
  tvmazeId: source.tvmazeId,
  wikidataId: source.id,
});

const mergeIdentity = (
  ...identities: (VideoMetadataIdentity | undefined)[]
): VideoMetadataIdentity => {
  const result: VideoMetadataIdentity = {};
  for (const identity of identities) {
    if (!identity) continue;
    result.tmdbId ??= identity.tmdbId;
    result.tvdbId ??= identity.tvdbId;
    result.imdbId ??= identity.imdbId;
    result.tvmazeId ??= identity.tvmazeId;
    result.wikidataId ??= identity.wikidataId;
  }
  return result;
};

const sourceDraftFromTmdb = (
  mediaType: VideoMetadataMediaType,
  details: TmdbMovieDetails | TmdbTvDetails,
  language?: string
): SourceDraft => {
  const fields = normalizeTmdbDetails(mediaType, details);
  const ids = mergeIdentity(fields);
  return {
    mediaType,
    provider: VideoMetadataSource.TMDB,
    sourceId: getTmdbSnapshotId(details.id, language),
    ...ids,
    fields,
    details,
    attributionUrl: getSourceLink(
      VideoMetadataSource.TMDB,
      mediaType,
      ids,
      String(details.id)
    ),
  };
};

const decodeRecord = (
  row: VideoMetadataSourceRecord
):
  | { draft: SourceDraft; fetchedAt: Date; refreshAt: Date; expiresAt: Date }
  | undefined => {
  const draft = snapshotFromRecord(row);
  if (!draft) return undefined;
  return {
    draft,
    fetchedAt: row.fetchedAt,
    refreshAt: row.refreshAt,
    expiresAt: row.expiresAt,
  };
};

const saveSourceDraft = async (
  draft: SourceDraft,
  now = new Date()
): Promise<void> => {
  const repository = getRepository(VideoMetadataSourceRecord);
  const sourceId = draft.sourceId.slice(0, 256);
  const expiresAt = getVideoMetadataExpiry(now);
  await repository.upsert(
    {
      mediaType: draft.mediaType,
      provider: draft.provider,
      sourceId,
      tmdbId: draft.tmdbId ?? null,
      tvdbId: draft.tvdbId ?? null,
      imdbId: draft.imdbId ?? null,
      tvmazeId: draft.tvmazeId ?? null,
      wikidataId: draft.wikidataId ?? null,
      payload: JSON.stringify({
        fields: draft.fields,
        ...(draft.details ? { details: draft.details } : {}),
      } satisfies NormalizedSnapshot),
      attributionUrl:
        draft.attributionUrl ??
        getSourceLink(draft.provider, draft.mediaType, draft, sourceId),
      fetchedAt: now,
      refreshAt: new Date(
        Math.min(
          now.getTime() + SOURCE_REFRESH_AGE_MS[draft.provider],
          expiresAt.getTime()
        )
      ),
      expiresAt,
    },
    ['mediaType', 'provider', 'sourceId']
  );
};

const loadVideoSourceRecords = async (
  mediaType: VideoMetadataMediaType,
  identity: VideoMetadataIdentity,
  now: Date
): Promise<VideoMetadataSourceRecord[]> => {
  const criteria = [
    ['tmdbId', identity.tmdbId],
    ['tvdbId', identity.tvdbId],
    ['imdbId', identity.imdbId],
    ['tvmazeId', identity.tvmazeId],
    ['wikidataId', identity.wikidataId],
  ] as const;
  const activeCriteria = criteria.filter(([, value]) => value !== undefined);
  if (activeCriteria.length === 0) return [];

  const repository = getRepository(VideoMetadataSourceRecord);
  const query = repository
    .createQueryBuilder('source')
    .where('source.mediaType = :mediaType', { mediaType })
    .andWhere(
      new Brackets((qb) => {
        activeCriteria.forEach(([field, value], index) => {
          qb.orWhere(`source.${field} = :identity${index}`, {
            [`identity${index}`]: value,
          });
        });
      })
    );
  const records = await query.getMany();
  const expired = records.filter((record) => record.expiresAt <= now);
  if (expired.length > 0) {
    await repository.remove(expired);
  }
  return records.filter((record) => record.expiresAt > now);
};

const getCachedMovieTitle = async (
  tmdbId: number,
  mediaType: VideoMetadataMediaType
): Promise<{
  title?: string;
  alternateTitle?: string;
  releaseDate?: string;
}> => {
  const media = await getRepository(Media).findOne({
    where: {
      tmdbId,
      mediaType: mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
    },
  });
  if (!media) return {};
  const metadata = await getRepository(MediaSearchMetadata).findOne({
    where: { mediaId: media.id },
  });
  if (
    metadata?.videoMetadataExpiresAt &&
    metadata.videoMetadataExpiresAt <= new Date()
  ) {
    return {};
  }
  return {
    title: cleanString(metadata?.title),
    alternateTitle: cleanString(metadata?.alternateTitle),
    releaseDate: cleanString(metadata?.releaseDate, 32),
  };
};

const getMediaIdentity = async (
  tmdbId: number,
  mediaType: VideoMetadataMediaType
): Promise<VideoMetadataIdentity> => {
  const media = await getRepository(Media).findOne({
    where: {
      tmdbId,
      mediaType: mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
    },
  });
  return {
    tmdbId,
    tvdbId: media?.tvdbId ?? undefined,
    imdbId: media?.imdbId ?? undefined,
  };
};

const findCachedSource = (
  rows: VideoMetadataSourceRecord[],
  source: VideoMetadataSource,
  now: Date
) =>
  rows
    .filter((record) => record.provider === source && record.expiresAt > now)
    .sort(
      (left, right) => right.fetchedAt.getTime() - left.fetchedAt.getTime()
    )[0];

const latestRecordsPerProvider = (
  rows: VideoMetadataSourceRecord[]
): VideoMetadataSourceRecord[] => {
  const latest = new Map<VideoMetadataSource, VideoMetadataSourceRecord>();
  for (const row of rows) {
    const current = latest.get(row.provider);
    if (!current || row.fetchedAt > current.fetchedAt) {
      latest.set(row.provider, row);
    }
  }
  return [...latest.values()];
};

const getTvdbDraft = async ({
  mediaType,
  identity,
  title,
  alternateTitle,
  releaseDate,
  cached,
}: {
  mediaType: VideoMetadataMediaType;
  identity: VideoMetadataIdentity;
  title?: string;
  alternateTitle?: string;
  releaseDate?: string;
  cached?: VideoMetadataSourceRecord;
}): Promise<SourceDraft | undefined> => {
  const now = new Date();
  const decoded = cached ? decodeRecord(cached) : undefined;
  if (decoded && decoded.refreshAt > now) return decoded.draft;

  try {
    const tvdb = await Tvdb.getInstance();
    let result: TvdbVideoMetadataRecord | undefined;
    if (identity.tvdbId) {
      try {
        result = await tvdb.getVideoMetadataById({
          mediaType,
          id: identity.tvdbId,
        });
      } catch (error) {
        logger.debug(
          'TheTVDB direct-ID metadata lookup failed; trying title search',
          {
            label: 'Video Metadata',
            mediaType,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          }
        );
      }
    } else if (identity.tmdbId) {
      try {
        result = await tvdb.getVideoMetadataByTmdbId({
          mediaType,
          tmdbId: identity.tmdbId,
        });
      } catch (error) {
        logger.debug(
          'TheTVDB remote-ID metadata lookup failed; trying title search',
          {
            label: 'Video Metadata',
            mediaType,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          }
        );
      }
    }
    if (!result) {
      const searchTitle = title ?? alternateTitle;
      if (!searchTitle) return undefined;
      const matches = await tvdb.searchVideoMetadata({
        query: searchTitle,
        mediaType,
      });
      const year = getYear(releaseDate);
      const exact = matches.filter((item) =>
        isExactSourceMatch({
          candidateTitles: [item.name, ...(item.aliases ?? [])],
          candidateYear:
            typeof item.firstAired === 'string'
              ? getYear(item.firstAired)
              : getYear(item.releaseDate ?? item.year),
          title: searchTitle,
          year,
        })
      );
      if (exact.length === 1) result = exact[0];
    }
    if (!result) return undefined;

    const fields = normalizeTvdb(result);
    const ids = mergeIdentity(identity, fields, {
      tvdbId: result.id,
    });
    return {
      mediaType,
      provider: VideoMetadataSource.TVDB,
      sourceId: String(result.id),
      ...ids,
      fields,
      attributionUrl: getSourceLink(
        VideoMetadataSource.TVDB,
        mediaType,
        ids,
        String(result.id)
      ),
    };
  } catch (error) {
    logger.debug('TheTVDB video metadata lookup failed', {
      label: 'Video Metadata',
      mediaType,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

const getTvmazeDraft = async ({
  identity,
  title,
  alternateTitle,
  releaseDate,
  cached,
}: {
  identity: VideoMetadataIdentity;
  title?: string;
  alternateTitle?: string;
  releaseDate?: string;
  cached?: VideoMetadataSourceRecord;
}): Promise<SourceDraft | undefined> => {
  const now = new Date();
  const decoded = cached ? decodeRecord(cached) : undefined;
  if (decoded && decoded.refreshAt > now) return decoded.draft;

  try {
    const tvmaze = new TvmazeAPI();
    let show: TvmazeShow | undefined;
    try {
      if (identity.tvmazeId) {
        show = await tvmaze.getShowById(identity.tvmazeId);
      } else if (identity.tvdbId || identity.imdbId) {
        show = await tvmaze.getShowByExternalId(identity);
      }
    } catch (error) {
      logger.debug('TVmaze ID lookup failed; trying exact title search', {
        label: 'Video Metadata',
        mediaType: 'tv',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    const searchTitle = title ?? alternateTitle;
    if (!show && searchTitle) {
      const matches = await tvmaze.searchShows(searchTitle);
      const year = getYear(releaseDate);
      const exact = matches.filter((candidate) =>
        isExactSourceMatch({
          candidateTitles: [candidate.name],
          candidateYear: getYear(candidate.premiered ?? undefined),
          title: searchTitle,
          year,
        })
      );
      if (exact.length === 1) show = exact[0];
    }
    if (!show) return undefined;

    const fields = normalizeTvmaze(show);
    const ids = mergeIdentity(identity, fields, {
      tvmazeId: show.id,
    });
    return {
      mediaType: 'tv',
      provider: VideoMetadataSource.TVMAZE,
      sourceId: String(show.id),
      ...ids,
      fields,
      attributionUrl: show.url,
    };
  } catch (error) {
    logger.debug('TVmaze video metadata lookup failed', {
      label: 'Video Metadata',
      mediaType: 'tv',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

const sameKnownIdentity = (
  source: VideoMetadataIdentity,
  known: VideoMetadataIdentity
): boolean =>
  (!!known.tmdbId && known.tmdbId === source.tmdbId) ||
  (!!known.tvdbId && known.tvdbId === source.tvdbId) ||
  (!!known.imdbId && known.imdbId === source.imdbId) ||
  (!!known.tvmazeId && known.tvmazeId === source.tvmazeId) ||
  (!!known.wikidataId && known.wikidataId === source.wikidataId);

const wikidataIdentity = (
  source: WikidataVideoMetadata,
  mediaType: VideoMetadataMediaType
): VideoMetadataIdentity => ({
  tmdbId:
    (mediaType === 'movie' ? source.tmdbMovieId : source.tmdbTvId) ??
    source.tmdbId,
  tvdbId:
    (mediaType === 'movie' ? source.tvdbMovieId : source.tvdbSeriesId) ??
    source.tvdbId,
  imdbId: source.imdbId,
  tvmazeId: source.tvmazeId,
  wikidataId: source.id,
});

const getWikidataDraft = async ({
  mediaType,
  identity,
  title,
  alternateTitle,
  releaseDate,
  cached,
}: {
  mediaType: VideoMetadataMediaType;
  identity: VideoMetadataIdentity;
  title?: string;
  alternateTitle?: string;
  releaseDate?: string;
  cached?: VideoMetadataSourceRecord;
}): Promise<SourceDraft | undefined> => {
  const now = new Date();
  const decoded = cached ? decodeRecord(cached) : undefined;
  if (decoded && decoded.refreshAt > now) return decoded.draft;

  try {
    const wikidata = new WikidataVideoMetadataAPI();
    let metadata: WikidataVideoMetadata | undefined;
    if (identity.wikidataId) {
      metadata = await wikidata.getVideoMetadata(identity.wikidataId);
    } else {
      const externalId:
        | {
            propertyId:
              'P4947' | 'P4983' | 'P12164' | 'P4835' | 'P345' | 'P4632';
            value: string;
          }
        | undefined = identity.tmdbId
        ? {
            propertyId: mediaType === 'movie' ? 'P4947' : 'P4983',
            value: String(identity.tmdbId),
          }
        : identity.tvdbId
          ? {
              propertyId: mediaType === 'movie' ? 'P12164' : 'P4835',
              value: String(identity.tvdbId),
            }
          : identity.imdbId
            ? { propertyId: 'P345', value: identity.imdbId }
            : identity.tvmazeId
              ? { propertyId: 'P4632', value: String(identity.tvmazeId) }
              : undefined;
      const candidates = externalId
        ? await wikidata.searchItemsByExternalId(externalId)
        : [];

      for (const candidate of candidates) {
        const item = await wikidata.getVideoMetadata(candidate.id);
        if (sameKnownIdentity(wikidataIdentity(item, mediaType), identity)) {
          metadata = item;
          break;
        }
      }

      const searchTitle = title ?? alternateTitle;
      if (!metadata && searchTitle) {
        const titleCandidates = await wikidata.searchItems(searchTitle);
        const year = getYear(releaseDate);
        for (const candidate of titleCandidates) {
          if (
            normalizeVideoTitle(candidate.label) !==
            normalizeVideoTitle(searchTitle)
          ) {
            continue;
          }
          const item = await wikidata.getVideoMetadata(candidate.id);
          if (
            sameKnownIdentity(wikidataIdentity(item, mediaType), identity) &&
            isExactSourceMatch({
              candidateTitles: [candidate.label, item.title],
              candidateYear: getYear(item.releaseDate),
              title: searchTitle,
              year,
            })
          ) {
            metadata = item;
            break;
          }
        }
      }
    }
    if (!metadata) return undefined;

    const matchedIdentity = wikidataIdentity(metadata, mediaType);
    if (
      Object.values(identity).some(Boolean) &&
      !sameKnownIdentity(matchedIdentity, identity)
    ) {
      return undefined;
    }
    const fields = normalizeWikidata(metadata, mediaType);
    const ids = mergeIdentity(identity, matchedIdentity, {
      wikidataId: metadata.id,
    });
    return {
      mediaType,
      provider: VideoMetadataSource.WIKIDATA,
      sourceId: metadata.id,
      ...ids,
      fields,
      attributionUrl: getSourceLink(
        VideoMetadataSource.WIKIDATA,
        mediaType,
        ids,
        metadata.id
      ),
    };
  } catch (error) {
    logger.debug('Wikidata video metadata lookup failed', {
      label: 'Video Metadata',
      mediaType,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

const SOURCE_ARRAY_FIELDS = [
  'genres',
  'studios',
  'networks',
  'directors',
  'writers',
] as const;
const SOURCE_VALUE_FIELDS = [
  'title',
  'originalTitle',
  'overview',
  'releaseDate',
  'runtime',
  'status',
  'imdbId',
  'tvdbId',
  'tvmazeId',
  'wikidataId',
  'tmdbId',
] as const;

const mergeNamedRecords = <T extends { name: string }>(
  existing: T[],
  names: string[],
  makeRecord: (name: string) => T
): T[] => {
  const values = new Map(
    existing.map((record) => [normalizeVideoTitle(record.name), record])
  );
  for (const name of names) {
    const key = normalizeVideoTitle(name);
    if (key && !values.has(key)) {
      values.set(key, makeRecord(name));
    }
  }
  return [...values.values()].slice(0, 50);
};

const mergeSourceFields = (
  records: { draft: SourceDraft; fetchedAt: Date; refreshAt: Date }[],
  priority: VideoMetadataSource[]
): {
  fields: VideoMetadataFields;
  fieldSources: Record<string, VideoMetadataSource[]>;
} => {
  const ordered = [...records].sort(
    (left, right) =>
      priority.indexOf(left.draft.provider) -
      priority.indexOf(right.draft.provider)
  );
  const fields: VideoMetadataFields = {
    genres: [],
    studios: [],
    networks: [],
    directors: [],
    writers: [],
  };
  const fieldSources: Record<string, VideoMetadataSource[]> = {};

  for (const field of SOURCE_VALUE_FIELDS) {
    for (const record of ordered) {
      const value = record.draft.fields[field];
      if (value !== undefined && value !== null && value !== '') {
        Object.assign(fields, { [field]: value });
        fieldSources[field] = [record.draft.provider];
        break;
      }
    }
  }

  for (const field of SOURCE_ARRAY_FIELDS) {
    const values = new Map<string, string>();
    const sources: VideoMetadataSource[] = [];
    for (const record of ordered) {
      const nextValues = record.draft.fields[field];
      if (!Array.isArray(nextValues) || nextValues.length === 0) continue;
      sources.push(record.draft.provider);
      for (const value of nextValues) {
        const key = normalizeVideoTitle(value);
        if (key && !values.has(key)) values.set(key, value);
      }
    }
    fields[field] = [...values.values()].slice(0, 50);
    if (sources.length > 0) {
      fieldSources[field] = [...new Set(sources)];
    }
  }

  return { fields, fieldSources };
};

const emptyMovieDetails = (
  tmdbId: number,
  fields: VideoMetadataFields
): TmdbMovieDetails =>
  ({
    id: tmdbId,
    adult: false,
    backdrop_path: undefined,
    budget: 0,
    genres: [],
    original_language: 'en',
    original_title: fields.originalTitle ?? fields.title ?? '',
    overview: fields.overview,
    popularity: 0,
    production_companies: [],
    production_countries: [],
    release_date: fields.releaseDate ?? '',
    release_dates: { results: [] },
    revenue: 0,
    runtime: fields.runtime,
    spoken_languages: [],
    status: fields.status ?? '',
    title: fields.title ?? '',
    video: false,
    vote_average: 0,
    vote_count: 0,
    credits: { cast: [], crew: [] },
    external_ids: {
      ...(fields.imdbId ? { imdb_id: fields.imdbId } : {}),
      ...(fields.tvdbId ? { tvdb_id: fields.tvdbId } : {}),
      ...(fields.wikidataId ? { wikidata_id: fields.wikidataId } : {}),
    },
    videos: { results: [] },
    keywords: { keywords: [] },
  }) as TmdbMovieDetails;

const emptyTvDetails = (
  tmdbId: number,
  fields: VideoMetadataFields
): TmdbTvDetails =>
  ({
    id: tmdbId,
    content_ratings: { results: [] },
    created_by: [],
    episode_run_time: fields.runtime ? [fields.runtime] : [],
    first_air_date: fields.releaseDate ?? '',
    genres: [],
    homepage: '',
    in_production:
      fields.status === 'Continuing' || fields.status === 'Running',
    languages: [],
    last_air_date: '',
    name: fields.title ?? '',
    networks: [],
    number_of_episodes: 0,
    number_of_seasons: 0,
    origin_country: [],
    original_language: 'en',
    original_name: fields.originalTitle ?? fields.title ?? '',
    overview: fields.overview ?? '',
    popularity: 0,
    production_companies: [],
    production_countries: [],
    spoken_languages: [],
    seasons: [],
    status: fields.status ?? '',
    type: 'Scripted',
    vote_average: 0,
    vote_count: 0,
    aggregate_credits: { cast: [] },
    credits: { crew: [] },
    external_ids: {
      ...(fields.imdbId ? { imdb_id: fields.imdbId } : {}),
      ...(fields.tvdbId ? { tvdb_id: fields.tvdbId } : {}),
      ...(fields.wikidataId ? { wikidata_id: fields.wikidataId } : {}),
    },
    keywords: { results: [] },
    videos: { results: [] },
  }) as TmdbTvDetails;

const applyMovieFallbacks = (
  input: TmdbMovieDetails | undefined,
  tmdbId: number,
  fields: VideoMetadataFields
): TmdbMovieDetails => {
  const movie = input ?? emptyMovieDetails(tmdbId, fields);
  const byName = new Map(
    (movie.genres ?? []).map((genre) => [
      normalizeVideoTitle(genre.name),
      genre.id,
    ])
  );
  const companyIds = new Map(
    (movie.production_companies ?? []).map((company) => [
      normalizeVideoTitle(company.name),
      company.id,
    ])
  );
  const externalIds = movie.external_ids ?? {};
  return {
    ...movie,
    title: cleanString(movie.title) ?? fields.title ?? '',
    original_title:
      cleanString(movie.original_title) ??
      fields.originalTitle ??
      fields.title ??
      '',
    overview: cleanString(movie.overview) ?? fields.overview,
    release_date:
      cleanString(movie.release_date, 32) ?? fields.releaseDate ?? '',
    runtime: movie.runtime ?? fields.runtime,
    status: cleanString(movie.status, 200) ?? fields.status ?? '',
    genres: mergeNamedRecords(movie.genres ?? [], fields.genres, (name) => ({
      id: byName.get(normalizeVideoTitle(name)) ?? 0,
      name,
    })),
    production_companies: mergeNamedRecords(
      movie.production_companies ?? [],
      fields.studios,
      (name) => ({
        id: companyIds.get(normalizeVideoTitle(name)) ?? 0,
        name,
        origin_country: '',
      })
    ),
    external_ids: {
      ...externalIds,
      imdb_id: movie.imdb_id ?? fields.imdbId,
      tvdb_id: externalIds.tvdb_id ?? fields.tvdbId,
      wikidata_id: externalIds.wikidata_id ?? fields.wikidataId,
    },
  };
};

const applyTvFallbacks = (
  input: TmdbTvDetails | undefined,
  tmdbId: number,
  fields: VideoMetadataFields
): TmdbTvDetails => {
  const series = input ?? emptyTvDetails(tmdbId, fields);
  const genreIds = new Map(
    (series.genres ?? []).map((genre) => [
      normalizeVideoTitle(genre.name),
      genre.id,
    ])
  );
  const companyIds = new Map(
    (series.production_companies ?? []).map((company) => [
      normalizeVideoTitle(company.name),
      company.id,
    ])
  );
  const networkIds = new Map(
    (series.networks ?? []).map((network) => [
      normalizeVideoTitle(network.name),
      network.id,
    ])
  );
  const externalIds = series.external_ids ?? {};
  return {
    ...series,
    name: cleanString(series.name) ?? fields.title ?? '',
    original_name:
      cleanString(series.original_name) ??
      fields.originalTitle ??
      fields.title ??
      '',
    overview: cleanString(series.overview) ?? fields.overview ?? '',
    first_air_date:
      cleanString(series.first_air_date, 32) ?? fields.releaseDate ?? '',
    episode_run_time:
      series.episode_run_time?.length > 0
        ? series.episode_run_time
        : fields.runtime
          ? [fields.runtime]
          : [],
    status: cleanString(series.status, 200) ?? fields.status ?? '',
    genres: mergeNamedRecords(series.genres ?? [], fields.genres, (name) => ({
      id: genreIds.get(normalizeVideoTitle(name)) ?? 0,
      name,
    })),
    networks: mergeNamedRecords(
      series.networks ?? [],
      fields.networks,
      (name) => ({
        id: networkIds.get(normalizeVideoTitle(name)) ?? 0,
        name,
      })
    ),
    production_companies: mergeNamedRecords(
      series.production_companies ?? [],
      fields.studios,
      (name) => ({
        id: companyIds.get(normalizeVideoTitle(name)) ?? 0,
        name,
        origin_country: '',
      })
    ),
    external_ids: {
      ...externalIds,
      imdb_id: externalIds.imdb_id ?? fields.imdbId,
      tvdb_id: externalIds.tvdb_id ?? fields.tvdbId,
      wikidata_id: externalIds.wikidata_id ?? fields.wikidataId,
    },
  };
};

const logProviderRefreshFailure = (
  provider: VideoMetadataSource,
  mediaType: VideoMetadataMediaType,
  error: unknown
) => {
  logger.debug('Video metadata provider refresh failed', {
    label: 'Video Metadata',
    provider,
    mediaType,
    errorMessage: error instanceof Error ? error.message : String(error),
  });
};

let lastVideoMetadataPruneAt = 0;
let videoMetadataPrunePromise: Promise<number> | undefined;

export const pruneExpiredVideoMetadata = async (
  now = new Date()
): Promise<number> => {
  const sourceResult = await getRepository(VideoMetadataSourceRecord).delete({
    expiresAt: LessThanOrEqual(now),
  });
  const searchResult = await getRepository(MediaSearchMetadata)
    .createQueryBuilder()
    .update(MediaSearchMetadata)
    .set({
      title: null,
      overview: null,
      posterPath: null,
      alternateTitle: null,
      releaseDate: null,
      genres: null,
      runtime: null,
      creator: null,
      director: null,
      writer: null,
      studio: null,
      network: null,
      provider: null,
      externalIds: null,
      searchText: '',
      videoMetadataExpiresAt: null,
    })
    .where('"videoMetadataExpiresAt" <= :now', { now })
    .execute();

  return (sourceResult.affected ?? 0) + (searchResult.affected ?? 0);
};

const pruneExpiredVideoMetadataIfDue = async (): Promise<void> => {
  const now = Date.now();
  if (videoMetadataPrunePromise) {
    await videoMetadataPrunePromise;
    return;
  }
  if (now - lastVideoMetadataPruneAt < 60 * 60 * 1000) {
    return;
  }
  lastVideoMetadataPruneAt = now;
  videoMetadataPrunePromise = pruneExpiredVideoMetadata().catch((error) => {
    logger.warn('Unable to prune expired video metadata snapshots', {
      label: 'Video Metadata',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return 0;
  });
  try {
    await videoMetadataPrunePromise;
  } finally {
    videoMetadataPrunePromise = undefined;
  }
};

const aggregateVideoMetadata = async ({
  tmdbId,
  mediaType,
  language,
}: {
  tmdbId: number;
  mediaType: VideoMetadataMediaType;
  language?: string;
}): Promise<AggregatedMovieMetadata | AggregatedTvMetadata> => {
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
    throw new Error('Invalid video metadata identity');
  }

  await pruneExpiredVideoMetadataIfDue();
  const now = new Date();
  const settings = await getSettings();
  const identity = await getMediaIdentity(tmdbId, mediaType);
  const rows = latestRecordsPerProvider(
    recordsForLanguage(
      await loadVideoSourceRecords(mediaType, identity, now),
      tmdbId,
      language
    )
  );
  const cachedTitles = await getCachedMovieTitle(tmdbId, mediaType);
  const cachedTmdb = findCachedSource(rows, VideoMetadataSource.TMDB, now);
  const cachedTvdb = findCachedSource(rows, VideoMetadataSource.TVDB, now);
  const cachedTvmaze = findCachedSource(rows, VideoMetadataSource.TVMAZE, now);
  const cachedWikidata = findCachedSource(
    rows,
    VideoMetadataSource.WIKIDATA,
    now
  );
  const tmdbCachedSnapshot = cachedTmdb ? decodeRecord(cachedTmdb) : undefined;
  const cachedTmdbDetails = tmdbCachedSnapshot?.draft.details as
    TmdbTvDetails | undefined;
  const cachedIsAnime =
    mediaType === 'tv' &&
    !!cachedTmdbDetails?.keywords?.results?.some(
      (keyword) => keyword.id === ANIME_KEYWORD_ID
    );
  let priority = getProviderPriority(
    mediaType,
    settings.metadataSettings,
    cachedIsAnime
  );
  const titleFromCache = mergeSourceFields(
    rows.flatMap((row) => {
      const snapshot = decodeRecord(row);
      return snapshot ? [snapshot] : [];
    }),
    priority
  ).fields;
  const title =
    cachedTitles.title ?? titleFromCache.title ?? cachedTitles.alternateTitle;
  const alternateTitle =
    cachedTitles.alternateTitle ?? titleFromCache.originalTitle ?? undefined;
  const releaseDate = cachedTitles.releaseDate ?? titleFromCache.releaseDate;

  let tmdbConfirmedMissing = false;
  const tmdbRefreshPromise =
    cachedTmdb && cachedTmdb.refreshAt > now
      ? Promise.resolve(undefined)
      : (async () => {
          try {
            const tmdb = new TheMovieDb();
            const details =
              mediaType === 'movie'
                ? await tmdb.getMovie({ movieId: tmdbId, language })
                : await tmdb.getTvShow({ tvId: tmdbId, language });
            const draft = sourceDraftFromTmdb(mediaType, details, language);
            try {
              await saveSourceDraft(draft);
            } catch (error) {
              logProviderRefreshFailure(
                VideoMetadataSource.TMDB,
                mediaType,
                error
              );
            }
            return draft;
          } catch (error) {
            if (errorHasHttpStatus(error, 404)) {
              tmdbConfirmedMissing = true;
            }
            logProviderRefreshFailure(
              VideoMetadataSource.TMDB,
              mediaType,
              error
            );
            return undefined;
          }
        })();

  const initialRefreshes: Promise<SourceDraft | undefined>[] = [];
  if (!cachedTvdb || cachedTvdb.refreshAt <= now) {
    initialRefreshes.push(
      getTvdbDraft({
        mediaType,
        identity,
        title,
        alternateTitle,
        releaseDate,
        cached: cachedTvdb,
      })
    );
  }
  if (mediaType === 'tv' && (!cachedTvmaze || cachedTvmaze.refreshAt <= now)) {
    initialRefreshes.push(
      getTvmazeDraft({
        identity,
        title,
        alternateTitle,
        releaseDate,
        cached: cachedTvmaze,
      })
    );
  }
  if (!cachedWikidata || cachedWikidata.refreshAt <= now) {
    initialRefreshes.push(
      getWikidataDraft({
        mediaType,
        identity,
        title,
        alternateTitle,
        releaseDate,
        cached: cachedWikidata,
      })
    );
  }

  const [tmdbDraft, refreshedSources] = await Promise.all([
    tmdbRefreshPromise,
    Promise.allSettled(initialRefreshes),
  ]);
  const activeTmdbDetails =
    (tmdbDraft?.details as TmdbMovieDetails | TmdbTvDetails | undefined) ??
    (tmdbCachedSnapshot?.draft.details as
      TmdbMovieDetails | TmdbTvDetails | undefined);
  const activeIsAnime =
    mediaType === 'tv' &&
    !!(activeTmdbDetails as TmdbTvDetails | undefined)?.keywords?.results?.some(
      (keyword) => keyword.id === ANIME_KEYWORD_ID
    );
  priority = getProviderPriority(
    mediaType,
    settings.metadataSettings,
    activeIsAnime
  );
  const firstPassDrafts = refreshedSources.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : []
  );
  const discoveredDrafts = [tmdbDraft, ...firstPassDrafts].filter(
    (draft): draft is SourceDraft => !!draft
  );
  const discoveredFields = mergeSourceFields(
    discoveredDrafts.map((draft) => ({
      draft,
      fetchedAt: now,
      refreshAt: now,
      expiresAt: getVideoMetadataExpiry(now),
    })),
    priority
  ).fields;
  const secondPassTitle = tmdbDraft?.fields.title ?? discoveredFields.title;
  const secondPassAlternateTitle =
    tmdbDraft?.fields.originalTitle ?? discoveredFields.originalTitle;
  const secondPassReleaseDate =
    tmdbDraft?.fields.releaseDate ?? discoveredFields.releaseDate;
  const postRefreshIdentity = mergeIdentity(
    identity,
    ...discoveredDrafts.map((draft) => draft.fields)
  );
  const needsSecondPass = !title && !!secondPassTitle;
  const secondRefreshes: Promise<SourceDraft | undefined>[] = [];
  if (needsSecondPass && (!cachedTvdb || cachedTvdb.refreshAt <= now)) {
    secondRefreshes.push(
      getTvdbDraft({
        mediaType,
        identity: postRefreshIdentity,
        title: secondPassTitle,
        alternateTitle: secondPassAlternateTitle,
        releaseDate: secondPassReleaseDate,
        cached: cachedTvdb,
      })
    );
  }
  if (
    mediaType === 'tv' &&
    needsSecondPass &&
    (!cachedTvmaze || cachedTvmaze.refreshAt <= now)
  ) {
    secondRefreshes.push(
      getTvmazeDraft({
        identity: postRefreshIdentity,
        title: secondPassTitle,
        alternateTitle: secondPassAlternateTitle,
        releaseDate: secondPassReleaseDate,
        cached: cachedTvmaze,
      })
    );
  }
  if (
    needsSecondPass &&
    (!cachedWikidata || cachedWikidata.refreshAt <= now) &&
    !firstPassDrafts.some(
      (draft) =>
        draft.provider === VideoMetadataSource.WIKIDATA && !!draft.fields.title
    )
  ) {
    secondRefreshes.push(
      getWikidataDraft({
        mediaType,
        identity: postRefreshIdentity,
        title: secondPassTitle,
        alternateTitle: secondPassAlternateTitle,
        releaseDate: secondPassReleaseDate,
        cached: cachedWikidata,
      })
    );
  }
  const secondRefreshResults = await Promise.allSettled(secondRefreshes);

  const draftBySource = new Map<string, SourceDraft>();
  if (tmdbDraft) {
    draftBySource.set(`${tmdbDraft.provider}:${tmdbDraft.sourceId}`, tmdbDraft);
  }
  for (const result of [...refreshedSources, ...secondRefreshResults]) {
    if (result.status === 'fulfilled' && result.value) {
      draftBySource.set(
        `${result.value.provider}:${result.value.sourceId}`,
        result.value
      );
    }
  }
  const savedDrafts = [...draftBySource.values()];
  for (const draft of savedDrafts) {
    if (draft.provider === VideoMetadataSource.TMDB) continue;
    try {
      await saveSourceDraft(draft);
    } catch (error) {
      logProviderRefreshFailure(draft.provider, mediaType, error);
    }
  }

  const allRecords = latestRecordsPerProvider(
    recordsForLanguage(
      await loadVideoSourceRecords(
        mediaType,
        mergeIdentity(identity, ...savedDrafts),
        new Date()
      ),
      tmdbId,
      language
    )
  );
  const allDecoded = allRecords.flatMap((row) => {
    const decoded = decodeRecord(row);
    return decoded ? [decoded] : [];
  });
  const persistedKeys = new Set(
    allDecoded.map(
      (record) => `${record.draft.provider}:${record.draft.sourceId}`
    )
  );
  const transientDecoded = savedDrafts.flatMap((draft) => {
    if (persistedKeys.has(`${draft.provider}:${draft.sourceId}`)) {
      return [];
    }
    const fetchedAt = new Date();
    return [
      {
        draft,
        fetchedAt,
        refreshAt: new Date(
          Math.min(
            fetchedAt.getTime() + SOURCE_REFRESH_AGE_MS[draft.provider],
            getVideoMetadataExpiry(fetchedAt).getTime()
          )
        ),
        expiresAt: getVideoMetadataExpiry(fetchedAt),
      },
    ];
  });
  allDecoded.push(...transientDecoded);
  const merged = mergeSourceFields(allDecoded, priority);
  const selectedTmdbRecord = allDecoded.find(
    (record) => record.draft.provider === VideoMetadataSource.TMDB
  );
  const tmdbDetails =
    (tmdbDraft?.details as TmdbMovieDetails | TmdbTvDetails | undefined) ??
    (selectedTmdbRecord?.draft.details as
      TmdbMovieDetails | TmdbTvDetails | undefined) ??
    (tmdbCachedSnapshot?.draft.details as
      TmdbMovieDetails | TmdbTvDetails | undefined);

  if (!merged.fields.title && !tmdbDetails) {
    if (tmdbConfirmedMissing) throw new VideoMetadataNotFoundError();
    throw new Error(
      'No cached or provider metadata is available for this title'
    );
  }

  const sources: VideoMetadataAttribution[] = allDecoded
    .sort(
      (left, right) =>
        priority.indexOf(left.draft.provider) -
        priority.indexOf(right.draft.provider)
    )
    .map((record) => ({
      source: record.draft.provider as VideoMetadataSourceName,
      url:
        record.draft.attributionUrl ??
        getSourceLink(
          record.draft.provider,
          mediaType,
          record.draft,
          record.draft.sourceId
        ),
      license: getLicenseLabel(record.draft.provider),
      licenseUrl: getLicenseUrl(record.draft.provider),
      fetchedAt: record.fetchedAt.toISOString(),
      stale: record.refreshAt <= new Date(),
    }));
  const lastUpdatedAt = allDecoded.reduce<Date | undefined>(
    (latest, record) =>
      !latest || record.fetchedAt > latest ? record.fetchedAt : latest,
    undefined
  );
  const expiresAt = allDecoded.reduce<Date | undefined>(
    (earliest, record) =>
      !earliest || record.expiresAt < earliest ? record.expiresAt : earliest,
    undefined
  );
  const provenance: VideoMetadataProvenance = {
    sources,
    fields: merged.fieldSources,
    lastUpdatedAt: lastUpdatedAt?.toISOString(),
    expiresAt: (expiresAt ?? getVideoMetadataExpiry(new Date())).toISOString(),
    supplemental: {
      genres: merged.fields.genres,
      studios: merged.fields.studios,
      networks: merged.fields.networks,
      directors: merged.fields.directors,
      writers: merged.fields.writers,
    },
  };

  if (mediaType === 'movie') {
    return {
      details: applyMovieFallbacks(
        tmdbDetails as TmdbMovieDetails | undefined,
        tmdbId,
        merged.fields
      ),
      provenance,
    };
  }

  return {
    details: applyTvFallbacks(
      tmdbDetails as TmdbTvDetails | undefined,
      tmdbId,
      merged.fields
    ),
    provenance,
  };
};

export const getAggregatedMovieMetadata = async (
  tmdbId: number,
  language?: string
): Promise<AggregatedMovieMetadata> =>
  (await aggregateVideoMetadata({
    tmdbId,
    mediaType: 'movie',
    language,
  })) as AggregatedMovieMetadata;

export const getAggregatedTvMetadata = async (
  tmdbId: number,
  language?: string
): Promise<AggregatedTvMetadata> =>
  (await aggregateVideoMetadata({
    tmdbId,
    mediaType: 'tv',
    language,
  })) as AggregatedTvMetadata;

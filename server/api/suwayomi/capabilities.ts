import { isRecord } from '@server/api/suwayomi/errors';
import { sanitizeVersion } from '@server/api/suwayomi/mappers';
import { ROOT_FIELDS } from '@server/api/suwayomi/operations';
import type {
  SuwayomiCapabilities,
  SuwayomiCapabilityWarning,
} from '@server/api/suwayomi/types';

/** The release this client is written and contract-tested against. */
export const PINNED_REVISION = 2366;
/** First release with `fetchMangaAndChapters`. */
export const MINIMUM_REVISION = 2223;
/** First release that returns cached data with `errors` from a failed fetch. */
export const PARTIAL_FETCH_REVISION = 2238;

export const parseRevision = (version: string | undefined) => {
  const match = /^v?\d+\.\d+\.(\d+)/.exec(version ?? '');
  return match ? Number(match[1]) : undefined;
};

const fieldNames = (type: unknown): Set<string> | undefined => {
  if (!isRecord(type) || !Array.isArray(type.fields)) {
    return undefined;
  }
  return new Set(
    type.fields.flatMap((field) =>
      isRecord(field) && typeof field.name === 'string' ? [field.name] : []
    )
  );
};

export interface CapabilityInput {
  about: unknown;
  /** Absent when introspection was unavailable. */
  introspection?: {
    queryType: unknown;
    mutationType: unknown;
    mangaType: unknown;
    chapterType: unknown;
  };
}

/**
 * Decides support from what the schema exposes rather than from the version
 * string; the version only adds warnings and the partial-result capability.
 */
export const evaluateCapabilities = ({
  about,
  introspection,
}: CapabilityInput): SuwayomiCapabilities => {
  const version = sanitizeVersion(isRecord(about) ? about.version : undefined);
  const buildType = sanitizeVersion(
    isRecord(about) ? about.buildType : undefined
  );
  const revision = parseRevision(version);
  const warnings: SuwayomiCapabilityWarning[] = [];
  const missingFields: string[] = [];
  let perUserDownloadState = false;

  if (introspection) {
    const queryFields = fieldNames(introspection.queryType) ?? new Set();
    const mutationFields = fieldNames(introspection.mutationType) ?? new Set();
    missingFields.push(
      ...ROOT_FIELDS.query
        .filter((field) => !queryFields.has(field))
        .map((field) => `Query.${field}`),
      ...ROOT_FIELDS.mutation
        .filter((field) => !mutationFields.has(field))
        .map((field) => `Mutation.${field}`)
    );
    perUserDownloadState = [
      introspection.mangaType,
      introspection.chapterType,
    ].some((type) => fieldNames(type)?.has('user') ?? false);
  } else {
    warnings.push('INTROSPECTION_UNAVAILABLE');
  }

  if (revision === undefined) {
    warnings.push('UNKNOWN_VERSION');
  } else if (revision < PINNED_REVISION) {
    warnings.push('BELOW_PINNED_REVISION');
  }
  if (perUserDownloadState) {
    warnings.push('PER_USER_SCHEMA');
  }

  const revisionSupported =
    revision === undefined ? !!introspection : revision >= MINIMUM_REVISION;
  return {
    version,
    revision,
    buildType,
    supported: revisionSupported && missingFields.length === 0,
    missingFields,
    partialFetchResults:
      revision !== undefined && revision >= PARTIAL_FETCH_REVISION,
    perUserDownloadState,
    warnings,
  };
};

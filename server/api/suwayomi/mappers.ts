import { SuwayomiError, isRecord } from '@server/api/suwayomi/errors';
import type {
  SuwayomiHealth,
  SuwayomiSource,
} from '@server/api/suwayomi/types';

// Responses are validated field by field; nothing upstream is trusted as typed.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const DOWNLOADER_STATES = ['STARTED', 'STOPPED'] as const;

export const badResponse = (operation: string): never => {
  throw new SuwayomiError('BAD_RESPONSE', operation);
};

export const record = (
  value: unknown,
  operation: string
): Record<string, unknown> =>
  isRecord(value) ? value : badResponse(operation);

export const list = (value: unknown, operation: string): unknown[] =>
  Array.isArray(value) ? value : badResponse(operation);

export const nodes = (value: unknown, operation: string): unknown[] =>
  list(isRecord(value) ? value.nodes : undefined, operation);

/** IDs stay strings: `Int` IDs arrive as numbers, `LongString` IDs as digits. */
export const toIdString = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === 'string' && /^\d{1,19}$/.test(value)
    ? value
    : undefined;
};

const id = (value: unknown, operation: string): string =>
  toIdString(value) ?? badResponse(operation);

export const text = (value: unknown, max = 512): string | undefined =>
  typeof value === 'string'
    ? value.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, max) || undefined
    : undefined;

const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const oneOf = <T extends string, F extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: F
): T | F => allowed.find((item) => item === value) ?? fallback;

export const sanitizeVersion = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[\w.+-]{1,64}$/.test(value)
    ? value
    : undefined;

export const mapSource = (
  value: unknown,
  operation: string
): SuwayomiSource => {
  const raw = record(value, operation);
  const extension = isRecord(raw.extension) ? raw.extension : {};
  return {
    id: id(raw.id, operation),
    name: text(raw.name, 256) ?? '',
    displayName: text(raw.displayName, 256) ?? '',
    lang: text(raw.lang, 32) ?? '',
    contentWarning: oneOf(
      raw.contentWarning,
      ['SAFE', 'MIXED', 'NSFW'] as const,
      'UNKNOWN'
    ),
    supportsLatest: raw.supportsLatest === true,
    hasUpdate: extension.hasUpdate === true,
    isObsolete: extension.isObsolete === true,
  };
};

export const mapHealth = (
  data: Record<string, unknown>,
  operation: string
): SuwayomiHealth => {
  const status = record(data.downloadStatus, operation);
  const queue = list(status.queue, operation);
  const settings = isRecord(data.settings) ? data.settings : {};
  const sourceTotal = isRecord(data.sources)
    ? (int(data.sources.totalCount) ?? 0)
    : 0;
  const queueErrors = queue.filter(
    (item) => isRecord(item) && item.state === 'ERROR'
  ).length;
  const health: SuwayomiHealth = {
    version: sanitizeVersion(
      isRecord(data.aboutServer) ? data.aboutServer.version : undefined
    ),
    downloaderState: oneOf(status.state, DOWNLOADER_STATES, 'UNKNOWN'),
    queueLength: queue.length,
    queueErrors,
    // The built-in local source is always present.
    sourceCount: Math.max(0, sourceTotal - 1),
    settings: {
      downloadAsCbz: bool(settings.downloadAsCbz),
      autoDownloadNewChapters: bool(settings.autoDownloadNewChapters),
      excludeEntryWithUnreadChapters: bool(
        settings.excludeEntryWithUnreadChapters
      ),
      excludeUnreadChapters: bool(settings.excludeUnreadChapters),
      excludeNotStarted: bool(settings.excludeNotStarted),
      globalUpdateInterval: finite(settings.globalUpdateInterval),
      maxSourcesInParallel: int(settings.maxSourcesInParallel),
      flareSolverrEnabled: bool(settings.flareSolverrEnabled),
    },
    warnings: [],
  };
  if (health.settings.downloadAsCbz === false) {
    health.warnings.push('CBZ_DISABLED');
  }
  if (sourceTotal <= 1) {
    health.warnings.push('NO_SOURCES');
  }
  if (queueErrors > 0) {
    health.warnings.push('QUEUE_ERRORS');
  }
  return health;
};

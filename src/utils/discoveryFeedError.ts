export type DiscoveryFeedFailureKind =
  | 'rate-limited'
  | 'reconnect'
  | 'setup-required'
  | 'list-not-found'
  | 'temporary';

export interface DiscoveryFeedFailure {
  kind: DiscoveryFeedFailureKind;
  retryAfterSeconds?: number;
}

const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 60 * 60;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;

const getHeader = (headers: unknown, name: string): unknown => {
  const record = asRecord(headers);
  if (!record) return undefined;

  const getter = record.get;
  if (typeof getter === 'function') {
    const value = getter.call(headers, name);
    if (value !== undefined && value !== null) return value;
  }

  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  );
  return key ? record[key] : undefined;
};

const parseRetryAfter = (value: unknown, now: number): number => {
  let seconds: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    seconds = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (trimmed && Number.isFinite(numeric)) {
      seconds = numeric;
    } else {
      const date = Date.parse(trimmed);
      if (Number.isFinite(date)) seconds = (date - now) / 1000;
    }
  }

  return Math.max(
    1,
    Math.min(
      MAX_RETRY_AFTER_SECONDS,
      Math.ceil(seconds ?? DEFAULT_RETRY_AFTER_SECONDS)
    )
  );
};

export const getDiscoveryFeedFailure = (
  error: unknown,
  now = Date.now()
): DiscoveryFeedFailure => {
  const response = asRecord(asRecord(error)?.response);
  const status = response?.status;
  const responseData = asRecord(response?.data);
  const code = responseData?.code;

  if (status === 429 || code === 'PROVIDER_RATE_LIMITED') {
    return {
      kind: 'rate-limited',
      retryAfterSeconds: parseRetryAfter(
        getHeader(response?.headers, 'retry-after'),
        now
      ),
    };
  }
  if (code === 'RECONNECT_REQUIRED') return { kind: 'reconnect' };
  if (code === 'PROVIDER_SETUP_REQUIRED') return { kind: 'setup-required' };
  if (code === 'PROVIDER_LIST_NOT_FOUND') return { kind: 'list-not-found' };

  return { kind: 'temporary' };
};

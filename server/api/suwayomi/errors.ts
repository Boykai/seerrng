import type { SuwayomiAuthMode } from '@server/api/suwayomi/types';
import logger from '@server/logger';
import axios from 'axios';

/**
 * Stable codes for every Suwayomi failure. Messages are fixed per code so raw
 * upstream text (exception names, stack fragments, CRLF) never reaches an API
 * response, the UI or a log line.
 */
export const SUWAYOMI_ERROR_MESSAGES = {
  UNREACHABLE: 'Suwayomi could not be reached.',
  TIMEOUT: 'Suwayomi did not respond in time.',
  ABORTED: 'The Suwayomi request was cancelled.',
  REQUEST_REFUSED: 'The Suwayomi request target was refused.',
  AUTH_REQUIRED: 'Suwayomi requires authentication.',
  AUTH_FAILED: 'Suwayomi rejected the configured credentials.',
  AUTH_MODE_UNSUPPORTED: 'This Suwayomi authentication mode is not supported.',
  AUTH_MODE_MISMATCH:
    'The Suwayomi authentication mode does not match the configured mode.',
  NOT_FOUND: 'The Suwayomi item was not found.',
  NOT_DOWNLOADED: 'The chapter archive has not been downloaded.',
  UPSTREAM_ERROR: 'Suwayomi reported an error.',
  BAD_RESPONSE: 'Suwayomi returned an unexpected response.',
  HTTP_ERROR: 'Suwayomi returned an HTTP error.',
  RESPONSE_TOO_LARGE: 'The Suwayomi response exceeded the size limit.',
  UNSUPPORTED_SERVER: 'This Suwayomi server is not supported.',
  INVALID_ARGUMENT: 'The Suwayomi request arguments are invalid.',
} as const;

export type SuwayomiErrorCode = keyof typeof SUWAYOMI_ERROR_MESSAGES;

const RETRYABLE_CODES = new Set<SuwayomiErrorCode>([
  'UNREACHABLE',
  'TIMEOUT',
  'UPSTREAM_ERROR',
]);

const WARN_CODES = new Set<SuwayomiErrorCode>([
  'AUTH_FAILED',
  'AUTH_MODE_UNSUPPORTED',
  'AUTH_MODE_MISMATCH',
  'REQUEST_REFUSED',
  'UNSUPPORTED_SERVER',
]);

export interface SuwayomiErrorDetails {
  httpStatus?: number;
  errorCount?: number;
}

export class SuwayomiError extends Error {
  readonly code: SuwayomiErrorCode;
  /** One of this client's operation or route names, never upstream text. */
  readonly operation: string;
  readonly httpStatus?: number;
  readonly errorCount?: number;
  readonly retryable: boolean;

  constructor(
    code: SuwayomiErrorCode,
    operation: string,
    details: SuwayomiErrorDetails = {}
  ) {
    super(SUWAYOMI_ERROR_MESSAGES[code]);
    this.name = 'SuwayomiError';
    this.code = code;
    this.operation = operation;
    this.httpStatus = details.httpStatus;
    this.errorCount = details.errorCount;
    const status = details.httpStatus ?? 0;
    this.retryable =
      RETRYABLE_CODES.has(code) ||
      (code === 'HTTP_ERROR' &&
        (status >= 500 || status === 408 || status === 429));
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      operation: this.operation,
      httpStatus: this.httpStatus,
      errorCount: this.errorCount,
      retryable: this.retryable,
    };
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_CLASSIFIED_ERRORS = 50;
const MAX_CLASSIFIED_TEXT = 1_000;
const TOKEN_MISUSE_PATTERN =
  /cannot use refresh token|token intended for (?:a )?different audience/i;

// Ordered by priority: the first pattern any error matches wins.
const GRAPHQL_ERROR_PATTERNS: readonly (readonly [
  RegExp,
  SuwayomiErrorCode,
])[] = [
  [/incorrect username or password/i, 'AUTH_FAILED'],
  [/already logged[ -]?in/i, 'AUTH_MODE_MISMATCH'],
  [/\bunauthori[sz]ed\b/i, 'AUTH_REQUIRED'],
  [TOKEN_MISUSE_PATTERN, 'AUTH_REQUIRED'],
  [/\bnot found\b|NoSuchElementException/i, 'NOT_FOUND'],
];

/** Maps a GraphQL `errors` array to one code without keeping its text. */
export const classifyGraphQLErrors = (
  errors: readonly unknown[]
): SuwayomiErrorCode => {
  let best = GRAPHQL_ERROR_PATTERNS.length;
  for (const error of errors.slice(0, MAX_CLASSIFIED_ERRORS)) {
    const message =
      isRecord(error) && typeof error.message === 'string'
        ? error.message.slice(0, MAX_CLASSIFIED_TEXT)
        : '';
    const index = GRAPHQL_ERROR_PATTERNS.findIndex(([pattern]) =>
      pattern.test(message)
    );
    if (index !== -1 && index < best) {
      best = index;
    }
  }

  return GRAPHQL_ERROR_PATTERNS[best]?.[1] ?? 'UPSTREAM_ERROR';
};

const TRANSPORT_CODES = new Map<string, SuwayomiErrorCode>([
  ['ERR_CANCELED', 'ABORTED'],
  ['ABORT_ERR', 'ABORTED'],
  ['ECONNABORTED', 'TIMEOUT'],
  ['ETIMEDOUT', 'TIMEOUT'],
  ['ECONNREFUSED', 'UNREACHABLE'],
  ['ECONNRESET', 'UNREACHABLE'],
  ['EPIPE', 'UNREACHABLE'],
  ['ENOTFOUND', 'UNREACHABLE'],
  ['EAI_AGAIN', 'UNREACHABLE'],
  ['EHOSTUNREACH', 'UNREACHABLE'],
  ['ENETUNREACH', 'UNREACHABLE'],
  ['EACCES', 'REQUEST_REFUSED'],
]);

/**
 * Converts any thrown value into a SuwayomiError. The original error is
 * dropped, not attached as a cause, because axios errors carry the request
 * configuration and its Authorization header.
 */
export const toSuwayomiError = (
  error: unknown,
  operation: string
): SuwayomiError => {
  if (error instanceof SuwayomiError) {
    return error;
  }
  if (axios.isCancel(error)) {
    return new SuwayomiError('ABORTED', operation);
  }

  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof SuwayomiError) {
      return current;
    }
    const code = (current as NodeJS.ErrnoException).code;
    const transportCode =
      typeof code === 'string' ? TRANSPORT_CODES.get(code) : undefined;
    if (current.name === 'AbortError') {
      return new SuwayomiError('ABORTED', operation);
    }
    if (typeof code === 'string' && code.startsWith('ERR_FR_')) {
      return new SuwayomiError('REQUEST_REFUSED', operation);
    }
    if (transportCode) {
      return new SuwayomiError(transportCode, operation);
    }
    if (current.message === 'External API request target is not allowed.') {
      return new SuwayomiError('REQUEST_REFUSED', operation);
    }
    if (current.message.startsWith('maxContentLength size of')) {
      return new SuwayomiError('RESPONSE_TOO_LARGE', operation);
    }
    // axios: the connection closed before the response body ended.
    if (current.message === 'stream has been aborted') {
      return new SuwayomiError('UNREACHABLE', operation);
    }
    current = current.cause;
  }

  return new SuwayomiError(
    axios.isAxiosError(error) && !error.response
      ? 'UNREACHABLE'
      : 'BAD_RESPONSE',
    operation
  );
};

export const readHeader = (
  headers: unknown,
  name: string
): string | undefined => {
  if (!isRecord(headers)) {
    return undefined;
  }
  const value = headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
};

export const isBasicChallenge = (headers: unknown): boolean =>
  /^\s*basic\b/i.test(readHeader(headers, 'www-authenticate') ?? '');

/** Maps an HTTP status on a route that requires credentials. */
export const authStatusCode = (
  status: number,
  mode: SuwayomiAuthMode,
  headers: unknown
): SuwayomiErrorCode | undefined => {
  if (status === 401) {
    if (mode === 'BASIC_AUTH') {
      return 'AUTH_FAILED';
    }
    return isBasicChallenge(headers) ? 'AUTH_MODE_MISMATCH' : 'AUTH_REQUIRED';
  }
  return status === 403 ? 'AUTH_FAILED' : undefined;
};

/** Token misuse is answered with HTTP 400 and a text or JSON body. */
const mentionsTokenMisuse = (body: unknown): boolean =>
  (typeof body === 'string'
    ? [body]
    : isRecord(body)
      ? Object.values(body).slice(0, 20)
      : []
  ).some(
    (value) =>
      typeof value === 'string' &&
      TOKEN_MISUSE_PATTERN.test(value.slice(0, MAX_CLASSIFIED_TEXT))
  );

export interface GraphQLResult {
  data: Record<string, unknown>;
  /** Set only for an accepted partial result. */
  errorCode?: SuwayomiErrorCode;
  errorCount: number;
}

export const interpretGraphQLResponse = (
  operation: string,
  response: { status: number; headers: unknown; data: unknown },
  mode: SuwayomiAuthMode,
  allowPartial = false
): GraphQLResult => {
  const { status, data: body } = response;
  const authCode = authStatusCode(status, mode, response.headers);
  if (authCode) {
    throw new SuwayomiError(authCode, operation, { httpStatus: status });
  }

  const ok = status >= 200 && status < 300;
  if (!ok && mentionsTokenMisuse(body)) {
    throw new SuwayomiError('AUTH_REQUIRED', operation, { httpStatus: status });
  }
  if (!isRecord(body)) {
    throw new SuwayomiError(ok ? 'BAD_RESPONSE' : 'HTTP_ERROR', operation, {
      httpStatus: status,
    });
  }

  const errors = Array.isArray(body.errors) ? body.errors : [];
  const data = isRecord(body.data) ? body.data : undefined;
  if (errors.length > 0) {
    const code = classifyGraphQLErrors(errors);
    // Auth is decided once per request, and only operations whose root fields
    // all require a user accept partial results. Once one of them resolved,
    // text that reads like an auth or lookup failure came from nested source
    // work (third-party text), so the result is partial.
    if (
      allowPartial &&
      data &&
      (code === 'UPSTREAM_ERROR' ||
        Object.values(data).some((value) => value !== null))
    ) {
      return { data, errorCode: 'UPSTREAM_ERROR', errorCount: errors.length };
    }
    throw new SuwayomiError(code, operation, {
      httpStatus: status,
      errorCount: errors.length,
    });
  }
  if (!ok) {
    throw new SuwayomiError('HTTP_ERROR', operation, { httpStatus: status });
  }
  if (!data) {
    throw new SuwayomiError('BAD_RESPONSE', operation, { httpStatus: status });
  }

  return { data, errorCount: 0 };
};

const reported = new WeakSet<SuwayomiError>();

/** Logs a sanitized one-line summary once per error and returns it. */
export const reportSuwayomiError = (error: SuwayomiError): SuwayomiError => {
  if (!reported.has(error)) {
    reported.add(error);
    logger[WARN_CODES.has(error.code) ? 'warn' : 'debug'](
      'Suwayomi request failed',
      {
        label: 'Suwayomi',
        operation: error.operation,
        code: error.code,
        errorCount: error.errorCount,
        httpStatus: error.httpStatus,
      }
    );
  }
  return error;
};

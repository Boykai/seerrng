import ExternalAPI, {
  DEFAULT_EXTERNAL_API_TIMEOUT_MS,
} from '@server/api/externalapi';
import type { AxiosResponse } from 'axios';
import axios from 'axios';

export type ReaderGroupingProvider = 'grimmory' | 'bookorbit';
export type ReaderGroupingTargetType =
  'author' | 'book-series' | 'comic-series';

export interface ReaderGroupingTarget {
  type: ReaderGroupingTargetType;
  id: string;
  name: string;
}

export interface ReaderGroupingRule {
  type?: 'rule';
  field: string;
  operator: string;
  value: string | string[];
}

/** The reader-service request that was running when a call failed. */
export type ReaderServiceStep =
  'sign-in' | 'list' | 'preview' | 'save' | 'count' | 'delete';

/**
 * - `http`: the service answered with an error status.
 * - `network`: no usable answer arrived (refused, timed out, TLS, too large).
 * - `not-api`: the answer was not JSON, such as a web page.
 * - `unexpected`: the JSON answer did not have the expected shape.
 * - `request`: SeerrNG did not send the request.
 */
export type ReaderServiceFailure =
  'http' | 'network' | 'not-api' | 'unexpected' | 'request';

/**
 * A reader-service failure reduced to its step, status, and error code. It
 * never carries the service's response body or the request's credentials.
 */
export class ReaderServiceError extends Error {
  public readonly step: ReaderServiceStep;
  public readonly reason: ReaderServiceFailure;
  public readonly status?: number;
  public readonly code?: string;

  public constructor(
    step: ReaderServiceStep,
    reason: ReaderServiceFailure,
    details: { status?: number; code?: string } = {}
  ) {
    super(
      'Reader service ' +
        step +
        ' request failed (' +
        (details.status !== undefined
          ? 'HTTP ' + details.status
          : (details.code ?? reason)) +
        ').'
    );
    this.name = 'ReaderServiceError';
    this.step = step;
    this.reason = reason;
    this.status = details.status;
    this.code = details.code;
  }
}

const toReaderServiceError = (
  step: ReaderServiceStep,
  error: unknown
): ReaderServiceError => {
  if (error instanceof ReaderServiceError) return error;
  if (axios.isAxiosError(error)) {
    const code = typeof error.code === 'string' ? error.code : undefined;
    const status = error.response?.status;
    return typeof status === 'number' && (status < 200 || status >= 300)
      ? new ReaderServiceError(step, 'http', { status, code })
      : new ReaderServiceError(step, 'network', { code });
  }
  return new ReaderServiceError(step, 'request');
};

export interface ReaderGroupingFilter {
  type: 'group';
  join: 'and' | 'AND';
  rules: ReaderGroupingRule[];
}

export interface ReaderGroupingPreview {
  matchedCount: number;
  sampleTitles: string[];
}

export interface ReaderGroupingCredentials {
  username: string;
  password: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const getCollection = (value: unknown): unknown[] | undefined => {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of [
    'items',
    'books',
    'content',
    'results',
    'entries',
    'ids',
    'bookIds',
  ]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  if (record.data !== undefined) return getCollection(record.data);
  return undefined;
};

const getCount = (
  value: unknown,
  arrayIsComplete = true
): number | undefined => {
  const record = asRecord(value);
  if (!record) {
    return Array.isArray(value) && arrayIsComplete ? value.length : undefined;
  }
  for (const key of [
    'total',
    'totalElements',
    'totalItems',
    'totalCount',
    'count',
  ]) {
    const candidate = record[key];
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= 0
    ) {
      return candidate;
    }
  }
  for (const key of ['page', 'pagination', 'meta']) {
    const nested = getCount(record[key], false);
    if (nested !== undefined) return nested;
  }
  for (const key of ['ids', 'bookIds']) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).length;
  }
  if (record.data !== undefined) return getCount(record.data, arrayIsComplete);
  return undefined;
};

const getSampleTitles = (value: unknown): string[] =>
  (getCollection(value) ?? [])
    .map((item) => {
      const record = asRecord(item);
      const title = record?.title ?? record?.name;
      return typeof title === 'string' ? title.trim() : '';
    })
    .filter(Boolean)
    .slice(0, 5);

export const parseReaderGroupingPreview = (
  value: unknown,
  arrayIsComplete = true
): ReaderGroupingPreview | undefined => {
  const matchedCount = getCount(value, arrayIsComplete);
  if (matchedCount === undefined) return undefined;
  return { matchedCount, sampleTitles: getSampleTitles(value) };
};

export const getReaderGroupingRemoteId = (
  value: unknown
): string | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['id', 'magicShelfId', 'smartScopeId']) {
    const id = record[key];
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
      return String(id);
    }
    if (typeof id === 'string' && id.trim() && id.length <= 255) {
      return id.trim();
    }
  }
  for (const key of ['data', 'magicShelf', 'smartScope']) {
    const nested = getReaderGroupingRemoteId(record[key]);
    if (nested) return nested;
  }
  return undefined;
};

export const buildReaderGroupingFilter = (
  provider: ReaderGroupingProvider,
  target: ReaderGroupingTarget
): ReaderGroupingFilter => {
  const comicFormats =
    provider === 'grimmory' ? ['CBR', 'CBZ', 'CB7'] : ['cbr', 'cbz', 'cb7'];
  // BookOrbit validates each rule's type; Grimmory rules do not carry one.
  const ruleType = provider === 'bookorbit' ? { type: 'rule' as const } : {};
  const rules: ReaderGroupingRule[] =
    target.type === 'author'
      ? [
          {
            ...ruleType,
            field: provider === 'grimmory' ? 'authors' : 'author',
            operator: provider === 'grimmory' ? 'includes_any' : 'includesAny',
            value: [target.name],
          },
        ]
      : [
          {
            ...ruleType,
            field: provider === 'grimmory' ? 'seriesName' : 'series',
            operator: provider === 'grimmory' ? 'equals' : 'eq',
            value: target.name,
          },
          ...(target.type === 'comic-series'
            ? [
                {
                  ...ruleType,
                  field: provider === 'grimmory' ? 'fileType' : 'format',
                  operator:
                    provider === 'grimmory' ? 'includes_any' : 'includesAny',
                  value: comicFormats,
                },
              ]
            : []),
        ];

  return {
    type: 'group',
    join: provider === 'grimmory' ? 'and' : 'AND',
    rules,
  };
};

/**
 * Spring turns a single query value into a list by splitting it on commas,
 * so a value that contains a comma is repeated to keep it whole.
 */
const grimmoryQueryList = (value: string): string[] =>
  value.includes(',') ? [value, value] : [value];

export const describeReaderGroupingRule = (
  target: ReaderGroupingTarget
): string => {
  if (target.type === 'author') return 'Books by author: ' + target.name;
  if (target.type === 'comic-series') {
    return 'Comic series: ' + target.name + ' (CBR, CBZ, or CB7 files)';
  }
  return 'Book series: ' + target.name;
};

export class ReaderDeliveryApi extends ExternalAPI {
  public constructor(baseUrl: string) {
    super(
      baseUrl,
      {},
      {
        allowPrivateAddresses: true,
        timeout: DEFAULT_EXTERNAL_API_TIMEOUT_MS,
        maxContentLength: 4 * 1024 * 1024,
        maxBodyLength: 256 * 1024,
      }
    );
  }

  private async call<T>(
    step: ReaderServiceStep,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    token?: string,
    body?: unknown,
    params?: Record<string, unknown>
  ): Promise<T> {
    let response: AxiosResponse<T>;
    try {
      response = await this.request<T>(method, endpoint, body, {
        headers: token ? { Authorization: 'Bearer ' + token } : undefined,
        params,
        // Lists are sent as repeated keys (a=1&a=2), the form Spring binds.
        paramsSerializer: { indexes: null },
        maxRedirects: 0,
      });
    } catch (error) {
      throw toReaderServiceError(step, error);
    }
    // A text answer, such as a web page, means the address is not the API.
    if (method !== 'DELETE' && typeof response.data === 'string') {
      throw new ReaderServiceError(step, 'not-api');
    }
    return response.data;
  }

  public async login(
    provider: ReaderGroupingProvider,
    credentials: ReaderGroupingCredentials
  ): Promise<string> {
    const account = {
      username: credentials.username,
      password: credentials.password,
    };
    let response: unknown;
    if (provider === 'bookorbit') {
      try {
        response = await this.call<unknown>(
          'sign-in',
          'POST',
          '/api/v1/auth/login',
          undefined,
          { ...account, clientKind: 'native', deviceLabel: 'SeerrNG' }
        );
      } catch (error) {
        // BookOrbit releases before 3.0 accept only a username and password.
        if (!(error instanceof ReaderServiceError && error.status === 400)) {
          throw error;
        }
        response = await this.call<unknown>(
          'sign-in',
          'POST',
          '/api/v1/auth/login',
          undefined,
          account
        );
      }
    } else {
      response = await this.call<unknown>(
        'sign-in',
        'POST',
        '/api/v1/auth/login',
        undefined,
        account
      );
    }
    const record = asRecord(response);
    const token = record?.accessToken ?? asRecord(record?.data)?.accessToken;
    if (typeof token !== 'string' || !token) {
      throw new ReaderServiceError('sign-in', 'unexpected');
    }
    return token;
  }

  public async listGroupings(
    provider: ReaderGroupingProvider,
    token: string
  ): Promise<unknown[]> {
    const endpoint =
      provider === 'grimmory' ? '/api/magic-shelves' : '/api/v1/smart-scopes';
    const response = await this.call<unknown>('list', 'GET', endpoint, token);
    const values = getCollection(response);
    if (!values) throw new ReaderServiceError('list', 'unexpected');
    return values;
  }

  public async preview(
    provider: ReaderGroupingProvider,
    token: string,
    target: ReaderGroupingTarget
  ): Promise<ReaderGroupingPreview> {
    if (provider === 'grimmory') {
      const params: Record<string, unknown> = { page: 0, size: 5 };
      if (target.type === 'author') {
        params.authors = grimmoryQueryList(target.name);
      } else {
        params.series = grimmoryQueryList(target.name);
      }
      if (target.type === 'comic-series') {
        // Grimmory files CBR, CBZ, and CB7 archives under one CBX type.
        params.fileType = ['CBX'];
      }
      const response = await this.call<unknown>(
        'preview',
        'GET',
        '/api/v1/app/books',
        token,
        undefined,
        params
      );
      const preview = parseReaderGroupingPreview(response, false);
      if (!preview) {
        throw new ReaderServiceError('preview', 'unexpected');
      }
      return preview;
    }

    const filter = buildReaderGroupingFilter(provider, target);
    const response = await this.call<unknown>(
      'preview',
      'POST',
      '/api/v1/books/query',
      token,
      { filter, sort: [], pagination: { page: 0, size: 5 } }
    );
    const preview = parseReaderGroupingPreview(response, false);
    if (!preview) {
      throw new ReaderServiceError('preview', 'unexpected');
    }
    return preview;
  }

  public async saveGrouping(
    provider: ReaderGroupingProvider,
    token: string,
    group: {
      id?: string;
      name: string;
      filter: ReaderGroupingFilter;
      isPublic: boolean;
      syncToKobo: boolean;
    }
  ): Promise<string> {
    const payload =
      provider === 'grimmory'
        ? {
            ...(group.id ? { id: Number(group.id) } : {}),
            name: group.name,
            icon: 'book-open',
            iconType: 'LUCIDE',
            filterJson: JSON.stringify(group.filter),
            isPublic: group.isPublic,
          }
        : {
            name: group.name,
            icon: 'books',
            filter: group.filter,
            // Required when creating a scope on BookOrbit releases before 3.0.
            ...(group.id ? {} : { defaultSort: [] }),
            isPublic: group.isPublic,
            syncToKobo: group.syncToKobo,
          };
    const endpoint =
      provider === 'grimmory'
        ? '/api/magic-shelves'
        : group.id
          ? '/api/v1/smart-scopes/' + encodeURIComponent(group.id)
          : '/api/v1/smart-scopes';
    const response = await this.call<unknown>(
      'save',
      provider === 'grimmory' ? 'POST' : group.id ? 'PATCH' : 'POST',
      endpoint,
      token,
      payload
    );
    const remoteId = getReaderGroupingRemoteId(response) ?? group.id;
    if (!remoteId) {
      throw new ReaderServiceError('save', 'unexpected');
    }
    return remoteId;
  }

  public async findGroupingIdByName(
    provider: ReaderGroupingProvider,
    token: string,
    name: string
  ): Promise<string | undefined> {
    const grouping = (await this.listGroupings(provider, token)).find(
      (item) => asRecord(item)?.name === name
    );
    return getReaderGroupingRemoteId(grouping);
  }

  public async getGroupingCount(
    provider: ReaderGroupingProvider,
    token: string,
    remoteId: string
  ): Promise<number> {
    const endpoint =
      provider === 'grimmory'
        ? '/api/v1/app/shelves/magic/' + encodeURIComponent(remoteId) + '/books'
        : '/api/v1/smart-scopes/' + encodeURIComponent(remoteId) + '/books';
    const response = await this.call<unknown>(
      'count',
      'GET',
      endpoint,
      token,
      undefined,
      { page: 0, size: 1 }
    );
    const count = getCount(response, false);
    if (count === undefined) {
      throw new ReaderServiceError('count', 'unexpected');
    }
    return count;
  }

  public async deleteGrouping(
    provider: ReaderGroupingProvider,
    token: string,
    remoteId: string
  ): Promise<void> {
    const endpoint =
      provider === 'grimmory'
        ? '/api/magic-shelves/' + encodeURIComponent(remoteId)
        : '/api/v1/smart-scopes/' + encodeURIComponent(remoteId);
    await this.call<unknown>('delete', 'DELETE', endpoint, token);
  }
}

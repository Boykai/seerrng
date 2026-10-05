import ExternalAPI, {
  DEFAULT_EXTERNAL_API_TIMEOUT_MS,
} from '@server/api/externalapi';

export type ReaderGroupingProvider = 'grimmory' | 'bookorbit';
export type ReaderGroupingTargetType =
  'author' | 'book-series' | 'comic-series';

export interface ReaderGroupingTarget {
  type: ReaderGroupingTargetType;
  id: string;
  name: string;
}

export interface ReaderGroupingRule {
  field: string;
  operator: string;
  value: string | string[];
}

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
  const rules: ReaderGroupingRule[] =
    target.type === 'author'
      ? [
          {
            field: provider === 'grimmory' ? 'authors' : 'author',
            operator: provider === 'grimmory' ? 'includes_any' : 'includesAny',
            value: [target.name],
          },
        ]
      : [
          {
            field: provider === 'grimmory' ? 'seriesName' : 'series',
            operator: provider === 'grimmory' ? 'equals' : 'eq',
            value: target.name,
          },
          ...(target.type === 'comic-series'
            ? [
                {
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
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    token?: string,
    body?: unknown,
    params?: Record<string, unknown>
  ): Promise<T> {
    const response = await this.request<T>(method, endpoint, body, {
      headers: token ? { Authorization: 'Bearer ' + token } : undefined,
      params,
      maxRedirects: 0,
    });
    return response.data;
  }

  public async login(
    provider: ReaderGroupingProvider,
    credentials: ReaderGroupingCredentials
  ): Promise<string> {
    const payload =
      provider === 'bookorbit'
        ? {
            ...credentials,
            clientKind: 'native',
            deviceLabel: 'SeerrNG',
          }
        : credentials;
    const response = await this.call<unknown>(
      'POST',
      '/api/v1/auth/login',
      undefined,
      payload
    );
    const record = asRecord(response);
    const token = record?.accessToken ?? asRecord(record?.data)?.accessToken;
    if (typeof token !== 'string' || !token) {
      throw new Error('Reader service did not return an access token.');
    }
    return token;
  }

  public async listGroupings(
    provider: ReaderGroupingProvider,
    token: string
  ): Promise<unknown[]> {
    const endpoint =
      provider === 'grimmory' ? '/api/magic-shelves' : '/api/v1/smart-scopes';
    const response = await this.call<unknown>('GET', endpoint, token);
    const values = getCollection(response);
    if (!values)
      throw new Error('Reader service returned an invalid grouping list.');
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
        params.authors = JSON.stringify([target.name]);
      } else {
        params.series = JSON.stringify([target.name]);
      }
      if (target.type === 'comic-series') {
        params.fileType = JSON.stringify(['CBR', 'CBZ', 'CB7']);
      }
      const response = await this.call<unknown>(
        'GET',
        '/api/v1/app/books',
        token,
        undefined,
        params
      );
      const preview = parseReaderGroupingPreview(response, false);
      if (!preview) {
        throw new Error('Grimmory returned an invalid match count.');
      }
      return preview;
    }

    const filter = buildReaderGroupingFilter(provider, target);
    const response = await this.call<unknown>(
      'POST',
      '/api/v1/books/query',
      token,
      { filter, sort: [], pagination: { page: 0, size: 5 } }
    );
    const preview = parseReaderGroupingPreview(response, false);
    if (!preview) {
      throw new Error('BookOrbit returned an invalid match count.');
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
      provider === 'grimmory' ? 'POST' : group.id ? 'PATCH' : 'POST',
      endpoint,
      token,
      payload
    );
    const remoteId = getReaderGroupingRemoteId(response) ?? group.id;
    if (!remoteId) {
      throw new Error('Reader service did not return a grouping ID.');
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
      'GET',
      endpoint,
      token,
      undefined,
      { page: 0, size: 1 }
    );
    const count = getCount(response, false);
    if (count === undefined) {
      throw new Error('Reader service did not return a grouping count.');
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
    await this.call<unknown>('DELETE', endpoint, token);
  }
}

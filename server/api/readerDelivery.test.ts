import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildReaderGroupingFilter,
  describeReaderGroupingRule,
  parseReaderGroupingPreview,
  ReaderDeliveryApi,
  type ReaderGroupingTarget,
} from './readerDelivery';

type ReaderCall = {
  method: string;
  endpoint: string;
  data?: unknown;
  config?: AxiosRequestConfig;
};

class InspectReaderDeliveryApi extends ReaderDeliveryApi {
  public readonly calls: ReaderCall[] = [];

  public constructor(private readonly responses: unknown[]) {
    super('http://reader.test');
  }

  protected override async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    data?: unknown,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    this.calls.push({ method, endpoint, data, config });
    return { data: this.responses.shift() as T } as AxiosResponse<T>;
  }
}

const seriesTarget: ReaderGroupingTarget = {
  type: 'book-series',
  id: 'series/42',
  name: 'The Broken Earth',
};

describe('reader grouping rule construction', () => {
  it('builds provider-specific author, book-series, and comic-series rules', () => {
    assert.deepEqual(
      buildReaderGroupingFilter('grimmory', {
        ...seriesTarget,
        type: 'author',
        name: 'N. K. Jemisin',
      }),
      {
        type: 'group',
        join: 'and',
        rules: [
          {
            field: 'authors',
            operator: 'includes_any',
            value: ['N. K. Jemisin'],
          },
        ],
      }
    );
    assert.deepEqual(
      buildReaderGroupingFilter('bookorbit', {
        ...seriesTarget,
        type: 'comic-series',
      }),
      {
        type: 'group',
        join: 'AND',
        rules: [
          { field: 'series', operator: 'eq', value: seriesTarget.name },
          {
            field: 'format',
            operator: 'includesAny',
            value: ['cbr', 'cbz', 'cb7'],
          },
        ],
      }
    );
    assert.equal(
      describeReaderGroupingRule({
        ...seriesTarget,
        type: 'comic-series',
      }),
      'Comic series: The Broken Earth (CBR, CBZ, or CB7 files)'
    );
  });

  it('parses bounded previews and refuses unknown totals', () => {
    assert.deepEqual(
      parseReaderGroupingPreview({
        total: 42,
        books: [
          { title: 'The Fifth Season' },
          { name: 'The Obelisk Gate' },
          { title: '  ' },
        ],
      }),
      {
        matchedCount: 42,
        sampleTitles: ['The Fifth Season', 'The Obelisk Gate'],
      }
    );
    assert.equal(
      parseReaderGroupingPreview({ items: [{ title: 'One' }] }, false),
      undefined
    );
    assert.equal(
      parseReaderGroupingPreview({ items: [{ title: 'One' }] }),
      undefined
    );
    assert.equal(parseReaderGroupingPreview({ total: -1 }), undefined);
  });
});

describe('ReaderDeliveryApi', () => {
  it('uses provider login payloads and accepts a nested access token', async () => {
    const api = new InspectReaderDeliveryApi([
      { data: { accessToken: 'reader-token' } },
    ]);

    assert.equal(
      await api.login('bookorbit', { username: 'admin', password: 'secret' }),
      'reader-token'
    );
    assert.deepEqual(api.calls[0], {
      method: 'POST',
      endpoint: '/api/v1/auth/login',
      data: {
        username: 'admin',
        password: 'secret',
        clientKind: 'native',
        deviceLabel: 'SeerrNG',
      },
      config: { headers: undefined, params: undefined, maxRedirects: 0 },
    });
  });

  it('rejects login responses without an access token', async () => {
    const api = new InspectReaderDeliveryApi([
      { token: 'not-an-access-token' },
    ]);
    await assert.rejects(
      api.login('grimmory', { username: 'admin', password: 'secret' }),
      /did not return an access token/
    );
  });

  it('lists provider groupings with bearer authentication and validates the result shape', async () => {
    const api = new InspectReaderDeliveryApi([
      { data: { items: [{ id: 1 }] } },
    ]);

    assert.deepEqual(await api.listGroupings('grimmory', 'token'), [{ id: 1 }]);
    assert.equal(api.calls[0].endpoint, '/api/magic-shelves');
    assert.deepEqual(api.calls[0].config?.headers, {
      Authorization: 'Bearer token',
    });

    const invalidApi = new InspectReaderDeliveryApi([{ unexpected: [] }]);
    await assert.rejects(
      invalidApi.listGroupings('bookorbit', 'token'),
      /invalid grouping list/
    );
  });

  it('previews Grimmory author rules with a bounded page of sample titles and exact count', async () => {
    const api = new InspectReaderDeliveryApi([
      {
        totalElements: 7,
        content: [{ title: 'Parable of the Sower' }],
      },
    ]);
    const target = {
      ...seriesTarget,
      type: 'author' as const,
      name: 'Octavia E. Butler',
    };

    assert.deepEqual(await api.preview('grimmory', 'token', target), {
      matchedCount: 7,
      sampleTitles: ['Parable of the Sower'],
    });
    assert.equal(api.calls[0].method, 'GET');
    assert.equal(api.calls[0].endpoint, '/api/v1/app/books');
    assert.deepEqual(api.calls[0].config?.params, {
      page: 0,
      size: 5,
      authors: JSON.stringify(['Octavia E. Butler']),
    });
  });

  it('previews BookOrbit comic rules with a five-item sample and reported total', async () => {
    const api = new InspectReaderDeliveryApi([
      { data: { totalElements: 119, content: [{ title: 'Saga, Vol. 1' }] } },
    ]);
    const target = { ...seriesTarget, type: 'comic-series' as const };

    assert.deepEqual(await api.preview('bookorbit', 'token', target), {
      matchedCount: 119,
      sampleTitles: ['Saga, Vol. 1'],
    });
    assert.equal(api.calls[0].method, 'POST');
    assert.equal(api.calls[0].endpoint, '/api/v1/books/query');
    assert.deepEqual(api.calls[0].data, {
      filter: buildReaderGroupingFilter('bookorbit', target),
      sort: [],
      pagination: { page: 0, size: 5 },
    });
    assert.deepEqual(api.calls[0].config?.headers, {
      Authorization: 'Bearer token',
    });
  });

  it('creates and updates provider groupings with their native contracts', async () => {
    const filter = buildReaderGroupingFilter('grimmory', seriesTarget);
    const grimmory = new InspectReaderDeliveryApi([{ magicShelf: { id: 51 } }]);
    assert.equal(
      await grimmory.saveGrouping('grimmory', 'token', {
        name: 'SeerrNG series',
        filter,
        isPublic: true,
        syncToKobo: false,
      }),
      '51'
    );
    assert.equal(grimmory.calls[0].method, 'POST');
    assert.equal(grimmory.calls[0].endpoint, '/api/magic-shelves');
    assert.deepEqual(grimmory.calls[0].data, {
      name: 'SeerrNG series',
      icon: 'book-open',
      iconType: 'LUCIDE',
      filterJson: JSON.stringify(filter),
      isPublic: true,
    });

    const bookorbit = new InspectReaderDeliveryApi([
      { smartScopeId: 'scope/51' },
    ]);
    assert.equal(
      await bookorbit.saveGrouping('bookorbit', 'token', {
        id: 'scope/51',
        name: 'SeerrNG series',
        filter,
        isPublic: false,
        syncToKobo: true,
      }),
      'scope/51'
    );
    assert.equal(bookorbit.calls[0].method, 'PATCH');
    assert.equal(
      bookorbit.calls[0].endpoint,
      '/api/v1/smart-scopes/scope%2F51'
    );
    assert.deepEqual(bookorbit.calls[0].data, {
      name: 'SeerrNG series',
      icon: 'books',
      filter,
      isPublic: false,
      syncToKobo: true,
    });
  });

  it('reads verified totals and deletes encoded remote grouping identifiers', async () => {
    const api = new InspectReaderDeliveryApi([
      { data: { page: { total: 83 }, content: [] } },
      undefined,
    ]);

    assert.equal(
      await api.getGroupingCount('bookorbit', 'token', 'scope/with spaces'),
      83
    );
    await api.deleteGrouping('bookorbit', 'token', 'scope/with spaces');
    assert.deepEqual(
      api.calls.map(({ method, endpoint }) => ({ method, endpoint })),
      [
        {
          method: 'GET',
          endpoint: '/api/v1/smart-scopes/scope%2Fwith%20spaces/books',
        },
        {
          method: 'DELETE',
          endpoint: '/api/v1/smart-scopes/scope%2Fwith%20spaces',
        },
      ]
    );
    assert.deepEqual(api.calls[0].config?.params, { page: 0, size: 1 });
    assert.equal(api.calls[1].config?.headers?.Authorization, 'Bearer token');
  });
});

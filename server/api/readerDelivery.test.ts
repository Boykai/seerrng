import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import axios, { AxiosError } from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildReaderGroupingFilter,
  describeReaderGroupingRule,
  parseReaderGroupingPreview,
  ReaderDeliveryApi,
  ReaderServiceError,
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
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return { data: response as T } as AxiosResponse<T>;
  }
}

const bearer = (token: string) => ['Bearer', token].join(' ');

const requestConfig = (token?: string, params?: Record<string, unknown>) => ({
  headers: token ? { Authorization: bearer(token) } : undefined,
  params,
  paramsSerializer: { indexes: null },
  maxRedirects: 0,
});

const httpError = (status: number, data: unknown = {}) =>
  new AxiosError(
    'Request failed with status code ' + status,
    status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    undefined,
    undefined,
    { status, data } as AxiosResponse
  );

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
      buildReaderGroupingFilter('grimmory', {
        ...seriesTarget,
        type: 'comic-series',
      }),
      {
        type: 'group',
        join: 'and',
        rules: [
          { field: 'seriesName', operator: 'equals', value: seriesTarget.name },
          {
            field: 'fileType',
            operator: 'includes_any',
            value: ['CBR', 'CBZ', 'CB7'],
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
          {
            type: 'rule',
            field: 'series',
            operator: 'eq',
            value: seriesTarget.name,
          },
          {
            type: 'rule',
            field: 'format',
            operator: 'includesAny',
            value: ['cbr', 'cbz', 'cb7'],
          },
        ],
      }
    );
    assert.deepEqual(
      buildReaderGroupingFilter('bookorbit', {
        ...seriesTarget,
        type: 'author',
        name: 'N. K. Jemisin',
      }).rules,
      [
        {
          type: 'rule',
          field: 'author',
          operator: 'includesAny',
          value: ['N. K. Jemisin'],
        },
      ]
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

describe('ReaderDeliveryApi sign-in', () => {
  it('signs in to BookOrbit as a native client and accepts a nested access token', async () => {
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
      config: requestConfig(),
    });
  });

  it('sends only the username and password from a service configuration', async () => {
    const config = {
      url: 'https://reader.example.test',
      username: 'admin',
      password: 'secret',
    };
    const grimmory = new InspectReaderDeliveryApi([{ accessToken: 'token' }]);
    const bookorbit = new InspectReaderDeliveryApi([{ accessToken: 'token' }]);

    await grimmory.login('grimmory', config);
    await bookorbit.login('bookorbit', config);

    assert.deepEqual(grimmory.calls[0].data, {
      username: 'admin',
      password: 'secret',
    });
    assert.deepEqual(bookorbit.calls[0].data, {
      username: 'admin',
      password: 'secret',
      clientKind: 'native',
      deviceLabel: 'SeerrNG',
    });
  });

  it('signs in to BookOrbit with only the account when the native sign-in is refused as invalid', async () => {
    const api = new InspectReaderDeliveryApi([
      httpError(400, { message: ['property clientKind should not exist'] }),
      { accessToken: 'reader-token' },
    ]);

    assert.equal(
      await api.login('bookorbit', { username: 'admin', password: 'secret' }),
      'reader-token'
    );
    assert.equal(api.calls.length, 2);
    assert.deepEqual(api.calls[1].data, {
      username: 'admin',
      password: 'secret',
    });
  });

  it('does not repeat a sign-in the service rejected', async () => {
    const api = new InspectReaderDeliveryApi([httpError(401)]);

    await assert.rejects(
      api.login('bookorbit', { username: 'admin', password: 'secret' }),
      { name: 'ReaderServiceError', step: 'sign-in', status: 401 }
    );
    assert.equal(api.calls.length, 1);
  });

  it('reports sign-in answers without an access token or JSON', async () => {
    await assert.rejects(
      new InspectReaderDeliveryApi([{ token: 'not-an-access-token' }]).login(
        'grimmory',
        { username: 'admin', password: 'secret' }
      ),
      { step: 'sign-in', reason: 'unexpected' }
    );
    await assert.rejects(
      new InspectReaderDeliveryApi(['<!doctype html><title>App</title>']).login(
        'bookorbit',
        { username: 'admin', password: 'secret' }
      ),
      { step: 'sign-in', reason: 'not-api' }
    );
  });
});

describe('ReaderDeliveryApi failures', () => {
  it('keeps the step, status, and error code without response text or credentials', async () => {
    const rejected = new InspectReaderDeliveryApi([
      httpError(403, {
        message: 'Cannot modify this smartScope secret-detail',
      }),
    ]);
    const error = await rejected
      .listGroupings('bookorbit', 'token')
      .then(() => undefined)
      .catch((reason: unknown) => reason);

    assert.ok(error instanceof ReaderServiceError);
    assert.equal(error.step, 'list');
    assert.equal(error.reason, 'http');
    assert.equal(error.status, 403);
    assert.equal(
      error.message,
      'Reader service list request failed (HTTP 403).'
    );
    assert.equal(error.cause, undefined);

    const offline = new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED');
    await assert.rejects(
      new InspectReaderDeliveryApi([offline]).login('grimmory', {
        username: 'admin',
        password: 'secret',
      }),
      {
        step: 'sign-in',
        reason: 'network',
        code: 'ECONNREFUSED',
        message: 'Reader service sign-in request failed (ECONNREFUSED).',
      }
    );
    await assert.rejects(
      new InspectReaderDeliveryApi([
        new Error('External API request target is not allowed.'),
      ]).listGroupings('grimmory', 'token'),
      { step: 'list', reason: 'request' }
    );
  });

  it('reports a redirect as an HTTP answer rather than following it', async () => {
    const api = new InspectReaderDeliveryApi([httpError(302)]);

    await assert.rejects(api.listGroupings('grimmory', 'token'), {
      step: 'list',
      reason: 'http',
      status: 302,
    });
    assert.equal(api.calls[0].config?.maxRedirects, 0);
  });
});

describe('ReaderDeliveryApi groupings', () => {
  it('lists provider groupings with bearer authentication and validates the result shape', async () => {
    const api = new InspectReaderDeliveryApi([
      { data: { items: [{ id: 1 }] } },
    ]);

    assert.deepEqual(await api.listGroupings('grimmory', 'token'), [{ id: 1 }]);
    assert.equal(api.calls[0].endpoint, '/api/magic-shelves');
    assert.deepEqual(api.calls[0].config, requestConfig('token'));

    const bookorbit = new InspectReaderDeliveryApi([[{ id: 3 }, { id: 4 }]]);
    assert.equal(
      (await bookorbit.listGroupings('bookorbit', 'token')).length,
      2
    );
    assert.equal(bookorbit.calls[0].endpoint, '/api/v1/smart-scopes');

    await assert.rejects(
      new InspectReaderDeliveryApi([{ unexpected: [] }]).listGroupings(
        'bookorbit',
        'token'
      ),
      { step: 'list', reason: 'unexpected' }
    );
    await assert.rejects(
      new InspectReaderDeliveryApi(['<html></html>']).listGroupings(
        'bookorbit',
        'token'
      ),
      { step: 'list', reason: 'not-api' }
    );
  });

  it('previews Grimmory authors with repeated query values and a bounded page', async () => {
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
    assert.deepEqual(
      api.calls[0].config,
      requestConfig('token', {
        page: 0,
        size: 5,
        authors: ['Octavia E. Butler'],
      })
    );
    assert.equal(
      axios.getUri({ url: '/api/v1/app/books', ...api.calls[0].config }),
      '/api/v1/app/books?page=0&size=5&authors=Octavia+E.+Butler'
    );
  });

  it('previews Grimmory comic series by series name and comic archive type', async () => {
    const api = new InspectReaderDeliveryApi([{ totalElements: 2 }]);
    const target = {
      ...seriesTarget,
      type: 'comic-series' as const,
      name: 'Tales, Volume One',
    };

    assert.deepEqual(await api.preview('grimmory', 'token', target), {
      matchedCount: 2,
      sampleTitles: [],
    });
    assert.deepEqual(api.calls[0].config?.params, {
      page: 0,
      size: 5,
      series: ['Tales, Volume One', 'Tales, Volume One'],
      fileType: ['CBX'],
    });
    assert.equal(
      axios.getUri({ url: '/api/v1/app/books', ...api.calls[0].config }),
      '/api/v1/app/books?page=0&size=5&series=Tales,+Volume+One&series=Tales,+Volume+One&fileType=CBX'
    );
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
    assert.deepEqual(api.calls[0].config, requestConfig('token'));

    await assert.rejects(
      new InspectReaderDeliveryApi([{ items: [] }]).preview(
        'bookorbit',
        'token',
        target
      ),
      { step: 'preview', reason: 'unexpected' }
    );
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

    const scopeFilter = buildReaderGroupingFilter('bookorbit', seriesTarget);
    const created = new InspectReaderDeliveryApi([{ id: 7, name: 'Scope' }]);
    assert.equal(
      await created.saveGrouping('bookorbit', 'token', {
        name: 'SeerrNG series',
        filter: scopeFilter,
        isPublic: false,
        syncToKobo: false,
      }),
      '7'
    );
    assert.equal(created.calls[0].method, 'POST');
    assert.equal(created.calls[0].endpoint, '/api/v1/smart-scopes');
    assert.deepEqual(created.calls[0].data, {
      name: 'SeerrNG series',
      icon: 'books',
      filter: scopeFilter,
      defaultSort: [],
      isPublic: false,
      syncToKobo: false,
    });

    const bookorbit = new InspectReaderDeliveryApi([
      { smartScopeId: 'scope/51' },
    ]);
    assert.equal(
      await bookorbit.saveGrouping('bookorbit', 'token', {
        id: 'scope/51',
        name: 'SeerrNG series',
        filter: scopeFilter,
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
      filter: scopeFilter,
      isPublic: false,
      syncToKobo: true,
    });

    await assert.rejects(
      new InspectReaderDeliveryApi([{ ok: true }]).saveGrouping(
        'bookorbit',
        'token',
        {
          name: 'SeerrNG series',
          filter: scopeFilter,
          isPublic: false,
          syncToKobo: false,
        }
      ),
      { step: 'save', reason: 'unexpected' }
    );
  });

  it('reads verified totals and deletes encoded remote grouping identifiers', async () => {
    const api = new InspectReaderDeliveryApi([
      { data: { page: { total: 83 }, content: [] } },
      '',
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
    assert.deepEqual(api.calls[1].config, requestConfig('token'));

    await assert.rejects(
      new InspectReaderDeliveryApi([{ content: [] }]).getGroupingCount(
        'grimmory',
        'token',
        '5'
      ),
      { step: 'count', reason: 'unexpected' }
    );
    await assert.rejects(
      new InspectReaderDeliveryApi([httpError(404)]).deleteGrouping(
        'grimmory',
        'token',
        '5'
      ),
      { step: 'delete', reason: 'http', status: 404 }
    );
  });
});

import MangaDexAPI, {
  MANGADEX_API_URL,
  MangaDexBadResponseError,
  MangaDexRateLimitedError,
  resetMangaDexLimiterForTests,
} from '@server/api/mangadex';
import cacheManager from '@server/lib/cache';
import { getAppVersion } from '@server/utils/appVersion';
import type {
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import axios, { AxiosError } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

type StubResponse = {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
};

const UUID_1 = '00000000-0000-4000-8000-000000000001';
const UUID_2 = '00000000-0000-4000-8000-000000000002';
const UUID_3 = '00000000-0000-4000-8000-000000000003';

let now = 0;
let sleeps: number[] = [];

const stubMangaDex = (
  api: MangaDexAPI,
  respond: (url: URL) => StubResponse
): InternalAxiosRequestConfig[] => {
  const requests: InternalAxiosRequestConfig[] = [];
  (api as unknown as { axios: AxiosInstance }).axios.defaults.adapter = async (
    config
  ) => {
    requests.push(config);
    const {
      status = 200,
      data,
      headers = {},
    } = respond(new URL(String(config.url)));
    const response = {
      data,
      status,
      statusText: String(status),
      headers,
      config,
    } as AxiosResponse;
    if (status >= 400) {
      throw new AxiosError(
        `Request failed with status code ${status}`,
        AxiosError.ERR_BAD_REQUEST,
        config,
        undefined,
        response
      );
    }
    return response;
  };
  return requests;
};

const manga = (id: string, links: unknown) => ({
  id,
  type: 'manga',
  attributes: { title: { en: 'Invented Title' }, links },
});

const page = (data: unknown[], total = data.length) => ({
  result: 'ok',
  response: 'collection',
  data,
  limit: 100,
  offset: 0,
  total,
});

describe('MangaDex AniList links', () => {
  beforeEach(() => {
    now = 0;
    sleeps = [];
    resetMangaDexLimiterForTests({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
  });

  afterEach(() => {
    cacheManager.getCache('mangadex').flush();
    resetMangaDexLimiterForTests();
  });

  it('sends only UUIDs, every content rating and a SeerrNG user agent', async () => {
    const api = new MangaDexAPI();
    const requests = stubMangaDex(api, () => ({
      data: page([
        manga(UUID_1, { al: '101', mal: '9' }),
        manga(UUID_2, { mal: '7' }),
      ]),
    }));

    const links = await api.getAniListLinks([UUID_1, UUID_2, UUID_1]);

    assert.deepEqual(
      links,
      new Map([
        [UUID_1, 101],
        [UUID_2, null],
      ])
    );
    assert.equal(requests.length, 1);
    const url = new URL(String(requests[0].url));
    assert.equal(url.origin + url.pathname, `${MANGADEX_API_URL}/manga`);
    assert.deepEqual(
      [...url.searchParams],
      [
        ['ids[]', UUID_1],
        ['ids[]', UUID_2],
        ['limit', '2'],
        ['offset', '0'],
        ['contentRating[]', 'safe'],
        ['contentRating[]', 'suggestive'],
        ['contentRating[]', 'erotica'],
        ['contentRating[]', 'pornographic'],
      ]
    );
    assert.equal(requests[0].method, 'get');
    assert.equal(requests[0].data, undefined);
    assert.equal(
      requests[0].headers.get('User-Agent'),
      `SeerrNG/${getAppVersion()}`
    );
  });

  it('treats every unusable AniList link as no link', async () => {
    const values: unknown[] = [
      '0',
      '-1',
      'abc',
      '1.5',
      '0123',
      ' 12',
      '1e3',
      '2147483648',
      '99999999999',
      123,
      null,
      undefined,
    ];
    const uuid = (index: number) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const api = new MangaDexAPI();
    stubMangaDex(api, () => ({
      data: page([
        ...values.map((al, index) => manga(uuid(index), { al })),
        manga(uuid(values.length), null),
        manga(uuid(values.length + 1), []),
        { id: uuid(values.length + 2), type: 'manga' },
        manga(uuid(values.length + 3), { al: '2147483647' }),
      ]),
    }));

    const ids = Array.from({ length: values.length + 4 }, (_, i) => uuid(i));
    const links = await api.getAniListLinks(ids);

    assert.deepEqual(
      ids.map((id) => links.get(id)),
      [...Array(values.length + 3).fill(null), 2147483647]
    );
  });

  it('answers unknown and mismatched IDs with no link', async () => {
    const api = new MangaDexAPI();
    stubMangaDex(api, () => ({
      data: page([manga(UUID_3, { al: '303' }), manga(UUID_1, { al: '101' })]),
    }));

    const links = await api.getAniListLinks([UUID_1, UUID_2]);

    assert.deepEqual(
      links,
      new Map([
        [UUID_1, 101],
        [UUID_2, null],
      ])
    );
  });

  it('rejects a reply that does not answer the whole request', async () => {
    const replies: unknown[] = [
      page([manga(UUID_1, { al: '101' })], 2),
      { ...page([]), result: 'error' },
      { ...page([]), data: {} },
      { ...page([]), total: '0' },
      [],
      'ok',
    ];
    for (const reply of replies) {
      const api = new MangaDexAPI();
      stubMangaDex(api, () => ({ data: reply }));
      await assert.rejects(
        api.getAniListLinks([UUID_1, UUID_2]),
        MangaDexBadResponseError
      );
    }
    assert.equal(cacheManager.getCache('mangadex').data.keys().length, 0);
  });

  it('caches each answer, including no link', async () => {
    const api = new MangaDexAPI();
    const requests = stubMangaDex(api, (url) => ({
      data: page(
        url.searchParams
          .getAll('ids[]')
          .map((id) => manga(id, id === UUID_1 ? { al: '101' } : {}))
      ),
    }));

    await api.getAniListLinks([UUID_1, UUID_2]);
    const again = await api.getAniListLinks([UUID_2, UUID_1]);
    assert.equal(requests.length, 1);
    assert.deepEqual(
      again,
      new Map([
        [UUID_2, null],
        [UUID_1, 101],
      ])
    );

    await api.getAniListLinks([UUID_1, UUID_3]);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      new URL(String(requests[1].url)).searchParams.getAll('ids[]'),
      [UUID_3]
    );
    assert.equal(
      cacheManager.getCache('mangadex').data.getTtl(UUID_3)! - Date.now() >
        86_000_000,
      true
    );
  });

  it('spaces requests a second apart', async () => {
    const api = new MangaDexAPI();
    stubMangaDex(api, () => ({ data: page([]) }));

    await api.getAniListLinks([UUID_1]);
    await api.getAniListLinks([UUID_2]);

    assert.deepEqual(sleeps, [1000]);
  });

  it('honors Retry-After after a 429 and sends nothing during the cooldown', async () => {
    const api = new MangaDexAPI();
    let status = 429;
    const requests = stubMangaDex(api, () =>
      status === 429
        ? { status, headers: { 'retry-after': '120' } }
        : { data: page([]) }
    );

    await assert.rejects(
      api.getAniListLinks([UUID_1]),
      (error: unknown) =>
        error instanceof MangaDexRateLimitedError &&
        error.retryAfterSeconds === 120 &&
        error.requestSent
    );
    status = 200;
    now += 119_000;
    await assert.rejects(
      api.getAniListLinks([UUID_1]),
      (error: unknown) =>
        error instanceof MangaDexRateLimitedError &&
        error.retryAfterSeconds === 1 &&
        !error.requestSent
    );
    assert.equal(requests.length, 1);

    now += 1_000;
    await api.getAniListLinks([UUID_1]);
    assert.equal(requests.length, 2);
  });

  it('cools down for a minute after a 429 without Retry-After and an hour after a 403', async () => {
    for (const [status, seconds] of [
      [429, 60],
      [403, 3600],
    ]) {
      resetMangaDexLimiterForTests({ now: () => now });
      const api = new MangaDexAPI();
      stubMangaDex(api, () => ({ status }));
      await assert.rejects(
        api.getAniListLinks([UUID_1]),
        (error: unknown) =>
          error instanceof MangaDexRateLimitedError &&
          error.retryAfterSeconds === seconds
      );
      now += (seconds - 1) * 1000;
      await assert.rejects(
        api.getAniListLinks([UUID_1]),
        (error: unknown) =>
          error instanceof MangaDexRateLimitedError && !error.requestSent
      );
    }
  });

  it('passes other failures through without a cooldown', async () => {
    const api = new MangaDexAPI();
    let status = 503;
    const requests = stubMangaDex(api, () =>
      status === 503 ? { status } : { data: page([]) }
    );

    await assert.rejects(
      api.getAniListLinks([UUID_1]),
      (error: unknown) =>
        axios.isAxiosError(error) && error.response?.status === 503
    );
    status = 200;
    await api.getAniListLinks([UUID_1]);
    assert.equal(requests.length, 2);
  });

  it('sends nothing for an aborted signal or an invalid ID', async () => {
    const api = new MangaDexAPI();
    const requests = stubMangaDex(api, () => ({ data: page([]) }));
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      api.getAniListLinks([UUID_1], { signal: controller.signal })
    );
    for (const ids of [
      ['00000000-0000-4000-8000-00000000000G'],
      ['AAAAAAAA-0000-4000-8000-000000000001'],
      ['/manga/' + UUID_1],
      Array.from(
        { length: 101 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      ),
    ]) {
      await assert.rejects(api.getAniListLinks(ids), TypeError);
    }
    assert.equal(requests.length, 0);
  });

  it('cancels a request in flight', async () => {
    const api = new MangaDexAPI();
    const controller = new AbortController();
    (api as unknown as { axios: AxiosInstance }).axios.defaults.adapter = (
      config
    ) =>
      new Promise((_, reject) => {
        config.signal?.addEventListener?.('abort', () =>
          reject(new axios.CanceledError())
        );
        controller.abort();
      });

    await assert.rejects(
      api.getAniListLinks([UUID_1], { signal: controller.signal }),
      (error: unknown) => axios.isCancel(error)
    );
    assert.equal(cacheManager.getCache('mangadex').data.keys().length, 0);
  });
});

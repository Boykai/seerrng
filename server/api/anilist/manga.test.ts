import AnilistAPI, { AnilistRateLimitedError } from '@server/api/anilist';
import {
  AnilistBadResponseError,
  AnilistGraphQLError,
} from '@server/api/anilist/failures';
import type { AnilistMangaPageOptions } from '@server/api/anilist/manga';
import {
  anilistRateLimiter,
  resetAnilistRateLimiterForTests,
} from '@server/api/anilist/rateLimiter';
import cacheManager from '@server/lib/cache';
import { mapMangaDetails } from '@server/models/Manga';
import type {
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import axios, { AxiosError } from 'axios';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

type GraphQlBody = { query: string; variables: Record<string, unknown> };
type StubResponse = {
  status?: number;
  data: unknown;
  headers?: Record<string, string>;
};

let now = 0;
let sleeps: number[] = [];

const toResponse = (
  config: InternalAxiosRequestConfig,
  { status = 200, data, headers = {} }: StubResponse
): AxiosResponse =>
  ({
    data,
    status,
    statusText: String(status),
    headers,
    config,
  }) as AxiosResponse;

// A custom adapter skips validateStatus, so failures are thrown the way
// axios reports them.
const stubAnilist = (
  api: AnilistAPI,
  respond: (body: GraphQlBody) => StubResponse
): GraphQlBody[] => {
  const bodies: GraphQlBody[] = [];
  (api as unknown as { axios: AxiosInstance }).axios.defaults.adapter = async (
    config
  ) => {
    const body = JSON.parse(String(config.data)) as GraphQlBody;
    bodies.push(body);
    const response = toResponse(config, respond(body));
    if (response.status >= 400) {
      throw new AxiosError(
        `Request failed with status code ${response.status}`,
        AxiosError.ERR_BAD_REQUEST,
        config,
        undefined,
        response
      );
    }
    return response;
  };
  return bodies;
};

const coverUrl =
  'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/example.jpg';

const mangaFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 30013,
  idMal: 13,
  title: {
    romaji: 'Example Romaji',
    english: 'Example Title',
    native: 'Example Native',
  },
  synonyms: ['Example Alias'],
  format: 'MANGA',
  status: 'FINISHED',
  chapters: 120,
  volumes: 12,
  isAdult: false,
  coverImage: { extraLarge: coverUrl, large: coverUrl },
  bannerImage: null,
  genres: ['Drama'],
  startDate: { year: 1997, month: 7, day: 22 },
  countryOfOrigin: 'JP',
  averageScore: 88,
  ...overrides,
});

const mangaPage = (
  media: unknown[],
  pageInfo: Record<string, unknown> = {
    total: media.length,
    currentPage: 1,
    lastPage: 1,
    hasNextPage: false,
  }
): StubResponse => ({ data: { data: { Page: { pageInfo, media } } } });

const animePage = (): StubResponse => ({
  data: {
    data: {
      Page: {
        pageInfo: { currentPage: 1, hasNextPage: false },
        media: [{ id: 1, format: 'TV', title: { romaji: 'Example Anime' } }],
      },
    },
  },
});

const pageOptions = (
  overrides: Partial<AnilistMangaPageOptions> = {}
): AnilistMangaPageOptions => ({
  page: 1,
  sort: ['TRENDING_DESC'],
  includeAdult: false,
  includeNovels: false,
  ...overrides,
});

const rateLimited =
  (retryAfterSeconds: number, requestSent: boolean) => (error: unknown) => {
    assert.ok(error instanceof AnilistRateLimitedError);
    assert.equal(error.retryAfterSeconds, retryAfterSeconds);
    assert.equal(error.requestSent, requestSent);
    return true;
  };

beforeEach(() => {
  now = 1_000_000;
  sleeps = [];
  resetAnilistRateLimiterForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
});

afterEach(() => {
  mock.restoreAll();
  cacheManager.getCache('anilist').flush();
  resetAnilistRateLimiterForTests();
});

describe('AniList shared request budget', () => {
  it('spaces anime and manga requests from one budget', async () => {
    const anime = new AnilistAPI();
    const manga = new AnilistAPI();
    stubAnilist(anime, animePage);
    stubAnilist(manga, () => mangaPage([mangaFixture()]));

    await anime.getTrending(1);
    await manga.getMangaPage(pageOptions());

    assert.deepEqual(sleeps, [1_000]);
  });

  it('fails fast for every AniList caller until Retry-After passes', async () => {
    const manga = new AnilistAPI();
    const anime = new AnilistAPI();
    stubAnilist(manga, () => ({
      status: 429,
      data: { errors: [{ message: 'Too Many Requests.', status: 429 }] },
      headers: { 'retry-after': '120' },
    }));
    const animeBodies = stubAnilist(anime, animePage);

    await assert.rejects(
      manga.getMangaPage(pageOptions()),
      rateLimited(120, true)
    );
    await assert.rejects(anime.getTrending(1), rateLimited(120, false));
    assert.equal(animeBodies.length, 0);

    now += 120_000;
    await anime.getTrending(1);
    assert.equal(animeBodies.length, 1);
  });

  it('lets a caller give up sooner than the default wait', async () => {
    const searchClient = new AnilistAPI({ maxRateLimitWaitMs: 3_000 });
    const client = new AnilistAPI();
    stubAnilist(searchClient, () => mangaPage([mangaFixture()]));
    stubAnilist(client, () => mangaPage([mangaFixture()]));
    await client.getMangaPage(pageOptions({ page: 1 }));
    anilistRateLimiter.noteRateLimited(5);

    await assert.rejects(
      searchClient.getMangaPage(pageOptions({ page: 2 })),
      rateLimited(5, false)
    );
    await client.getMangaPage(pageOptions({ page: 3 }));
    assert.deepEqual(sleeps, [5_000]);
  });

  it('serves repeated lookups from cache without spending budget', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () => ({
      data: { data: { Media: mangaFixture() } },
    }));

    const first = await api.getMangaDetails(30013);
    const second = await api.getMangaDetails(30013);

    assert.deepEqual(second, first);
    assert.equal(bodies.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it('keeps manga and anime cache entries apart', async () => {
    const anime = new AnilistAPI();
    const manga = new AnilistAPI();
    const animeBodies = stubAnilist(anime, animePage);
    const mangaBodies = stubAnilist(manga, () => mangaPage([mangaFixture()]));

    const animeResult = await anime.getTrending(1);
    const mangaResult = await manga.getMangaPage(pageOptions());
    await anime.getTrending(1);
    await manga.getMangaPage(pageOptions());

    assert.equal(animeBodies.length, 1);
    assert.equal(mangaBodies.length, 1);
    assert.equal(animeResult.media[0]?.id, 1);
    assert.equal(mangaResult.media[0]?.id, 30013);
  });

  it('reports a rate-limited PIN exchange as a rate limit', async () => {
    const tokenClient = {
      interceptors: { request: { use: () => 0 } },
      post: async () => {
        throw new AxiosError(
          'Request failed with status code 429',
          AxiosError.ERR_BAD_REQUEST,
          undefined,
          undefined,
          {
            data: {},
            status: 429,
            statusText: '429',
            headers: { 'retry-after': '90' },
            config: {} as InternalAxiosRequestConfig,
          }
        );
      },
    };
    mock.method(axios, 'create', () => tokenClient);

    await assert.rejects(
      AnilistAPI.exchangePinCode('client-id', 'client-secret', 'code'),
      rateLimited(90, true)
    );
    mock.restoreAll();

    const api = new AnilistAPI();
    const bodies = stubAnilist(api, animePage);
    await assert.rejects(api.getTrending(1), rateLimited(90, false));
    assert.equal(bodies.length, 0);
  });
});

describe('AniList manga catalog requests', () => {
  it('sends exclusions to AniList and filters excluded results again', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () =>
      mangaPage(
        [
          mangaFixture({ id: 1 }),
          mangaFixture({ id: 2, isAdult: true }),
          mangaFixture({ id: 3, format: 'NOVEL' }),
          mangaFixture({ id: 'not-an-id' }),
        ],
        { total: 40, currentPage: 2, lastPage: 2, hasNextPage: false }
      )
    );

    const page = await api.getMangaPage(
      pageOptions({
        page: 2,
        sort: ['SCORE_DESC'],
        search: 'example',
        genre: 'Drama',
        format: 'MANGA',
        status: 'RELEASING',
        countryOfOrigin: 'KR',
      })
    );

    assert.match(bodies[0].query, /type: MANGA/);
    assert.deepEqual(bodies[0].variables, {
      page: 2,
      perPage: 20,
      sort: ['SCORE_DESC'],
      search: 'example',
      genre: 'Drama',
      formatIn: ['MANGA'],
      formatNotIn: ['NOVEL'],
      status: 'RELEASING',
      countryOfOrigin: 'KR',
      isAdult: false,
    });
    assert.deepEqual(
      page.media.map((manga) => manga.id),
      [1]
    );
    assert.deepEqual(page.pageInfo, {
      total: 40,
      currentPage: 2,
      lastPage: 2,
      hasNextPage: false,
    });
  });

  it('leaves out exclusions an administrator has enabled', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () =>
      mangaPage([
        mangaFixture({ id: 2, isAdult: true }),
        mangaFixture({ id: 3, format: 'NOVEL' }),
      ])
    );

    const page = await api.getMangaPage(
      pageOptions({ includeAdult: true, includeNovels: true })
    );

    assert.deepEqual(bodies[0].variables, {
      page: 1,
      perPage: 20,
      sort: ['TRENDING_DESC'],
    });
    assert.deepEqual(
      page.media.map((manga) => manga.id),
      [2, 3]
    );
  });

  it('sanitizes manga details', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () => ({
      data: {
        data: {
          Media: mangaFixture({
            description:
              '<p>Plot <span class="markdown_spoiler"><span>Secret</span></span><a href="https://example.com/x">link</a><img src="https://example.com/x.png" onerror="alert(1)"><br>More <i>text</i></p><script>alert(1)</script>',
            coverImage: {
              extraLarge: 'https://example.com/cover.jpg',
              large: coverUrl,
            },
            bannerImage: 'http://s4.anilist.co/file/banner.jpg',
            siteUrl: 'https://anilist.co/manga/30013',
            endDate: { year: 2001, month: null, day: null },
            tags: [
              { name: 'Revenge', rank: 80, isMediaSpoiler: false },
              { name: 'Twist', rank: 50, isGeneralSpoiler: true },
              { name: 'Nudity', rank: 30, isAdult: true },
              { name: '', rank: 10 },
            ],
            staff: {
              edges: [
                {
                  role: 'Story & Art',
                  node: { id: 10, name: { full: 'Writer One' } },
                },
                {
                  role: 'Translator (English)',
                  node: { id: 12, name: { full: 'Translator Three' } },
                },
                { role: 'Art', node: { id: 'bad', name: { full: 'Bad' } } },
              ],
            },
          }),
        },
      },
    }));

    const details = await api.getMangaDetails(30013);

    assert.match(bodies[0].query, /Media\(id: \$id, type: MANGA\)/);
    assert.deepEqual(bodies[0].variables, { id: 30013 });
    assert.ok(details);
    assert.equal(details.description, '<p>Plot link<br>More <i>text</i></p>');
    assert.equal(details.coverImage, coverUrl);
    assert.equal(details.bannerImage, undefined);
    assert.equal(details.siteUrl, 'https://anilist.co/manga/30013');
    assert.equal(details.startDate, '1997-07-22');
    assert.equal(details.endDate, '2001');
    assert.deepEqual(details.tags, [
      { name: 'Revenge', rank: 80, isSpoiler: false, isAdult: false },
      { name: 'Twist', rank: 50, isSpoiler: true, isAdult: false },
      { name: 'Nudity', rank: 30, isSpoiler: false, isAdult: true },
    ]);
    assert.deepEqual(details.staff, [
      { id: 10, name: 'Writer One', role: 'Story & Art' },
      { id: 12, name: 'Translator Three', role: 'Translator (English)' },
    ]);
  });

  it('drops links that leave AniList', async () => {
    const api = new AnilistAPI();
    stubAnilist(api, () => ({
      data: {
        data: {
          Media: mangaFixture({
            siteUrl: 'https://anilist.co.example.com/manga/30013',
            coverImage: { large: 'https://s4.anilist.co:8443/cover.jpg' },
          }),
        },
      },
    }));

    const details = await api.getMangaDetails(30013);

    assert.ok(details);
    assert.equal(details.siteUrl, undefined);
    assert.equal(details.coverImage, undefined);
  });

  it('returns null for unknown manga ids', async () => {
    const httpNotFound = new AnilistAPI();
    stubAnilist(httpNotFound, () => ({
      status: 404,
      data: {
        errors: [{ message: 'Not Found.', status: 404 }],
        data: { Media: null },
      },
    }));
    const graphQlNotFound = new AnilistAPI();
    stubAnilist(graphQlNotFound, () => ({
      data: {
        errors: [{ message: 'Not Found.', status: 404 }],
        data: { Media: null },
      },
    }));
    const emptyMedia = new AnilistAPI();
    stubAnilist(emptyMedia, () => ({ data: { data: { Media: null } } }));

    assert.equal(await httpNotFound.getMangaDetails(1), null);
    assert.equal(await graphQlNotFound.getMangaDetails(2), null);
    assert.equal(await emptyMedia.getMangaDetails(3), null);
  });

  it('still fails for AniList server errors', async () => {
    const api = new AnilistAPI();
    stubAnilist(api, () => ({ status: 500, data: {} }));

    await assert.rejects(api.getMangaDetails(4), (error: unknown) => {
      assert.ok(axios.isAxiosError(error));
      assert.equal(error.response?.status, 500);
      return true;
    });
  });

  it('keeps anime lookups on the ANIME type', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, (body) =>
      body.query.includes('MediaListCollection')
        ? { data: { data: { MediaListCollection: { lists: [] } } } }
        : body.query.includes('PageMedia')
          ? animePage()
          : { data: { data: { Media: { id: 5 } } } }
    );

    await api.getMedia(5);
    await api.getMediaListCollection(9);
    await api.getTrending(1);

    assert.deepEqual(bodies[0].variables, { id: 5, type: 'ANIME' });
    assert.deepEqual(bodies[1].variables, { userId: 9, type: 'ANIME' });
    assert.equal(bodies[2].variables.type, 'ANIME');
  });
});

describe('AniList library matching requests', () => {
  const malPage = (
    media: unknown[],
    pageInfo: unknown = { hasNextPage: false }
  ): StubResponse => ({ data: { data: { Page: { pageInfo, media } } } });

  it('reads one page of MyAnimeList links and keeps only requested IDs', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () =>
      malPage(
        [
          { id: 10, idMal: 55 },
          { id: 11, idMal: 55 },
          { id: 12, idMal: 99 },
          { id: 13, idMal: null },
        ],
        { hasNextPage: true }
      )
    );

    const page = await api.getMangaIdsByMalIds([55, 56], 2);

    assert.match(bodies[0].query, /idMal_in: \$malIds, type: MANGA/);
    assert.match(bodies[0].query, /perPage: 50/);
    assert.deepEqual(bodies[0].variables, { page: 2, malIds: [55, 56] });
    assert.deepEqual(page, {
      hasNextPage: true,
      links: [
        { anilistId: 10, malId: 55 },
        { anilistId: 11, malId: 55 },
      ],
    });
  });

  it('rejects malformed MyAnimeList link pages', async () => {
    const replies: StubResponse[] = [
      { data: { data: { Page: null } } },
      malPage([], {}),
      malPage([], { hasNextPage: 'false' }),
      { data: { data: { Page: { pageInfo: { hasNextPage: false } } } } },
      malPage([{ id: 0, idMal: 55 }]),
      malPage([{ id: '10', idMal: 55 }]),
      malPage([{ id: 2_147_483_648, idMal: 55 }]),
      malPage(['row']),
      malPage(
        Array.from({ length: 51 }, (_, index) => ({ id: index + 1, idMal: 55 }))
      ),
    ];
    for (const reply of replies) {
      const api = new AnilistAPI();
      stubAnilist(api, () => reply);
      await assert.rejects(
        api.getMangaIdsByMalIds([55], 1),
        (error: unknown) =>
          error instanceof Error && error.name === 'AnilistBadResponseError'
      );
    }
  });

  it('sends every MyAnimeList lookup and honors cancel and rate limits', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () => malPage([{ id: 10, idMal: 55 }]));

    await api.getMangaIdsByMalIds([55], 1);
    await api.getMangaIdsByMalIds([55], 1);
    assert.equal(bodies.length, 2);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      api.getMangaIdsByMalIds([55], 1, { signal: controller.signal }),
      (error: unknown) => axios.isCancel(error)
    );
    assert.equal(bodies.length, 2);

    const limited = new AnilistAPI();
    stubAnilist(limited, () => ({
      status: 429,
      data: {},
      headers: { 'retry-after': '30' },
    }));
    await assert.rejects(
      limited.getMangaIdsByMalIds([55], 1),
      rateLimited(30, true)
    );
  });

  it('searches titles under the content policy without caching', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () =>
      mangaPage([
        mangaFixture({ id: 1 }),
        mangaFixture({ id: 2, isAdult: true }),
        mangaFixture({ id: 3, format: 'NOVEL' }),
      ])
    );
    const policy = { includeAdult: false, includeNovels: false };

    const first = await api.searchMangaTitles('Fake Title', policy);
    await api.searchMangaTitles('Fake Title', policy);

    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].variables, {
      page: 1,
      perPage: 5,
      sort: ['SEARCH_MATCH'],
      search: 'Fake Title',
      formatNotIn: ['NOVEL'],
      isAdult: false,
    });
    assert.deepEqual(
      first.map((manga) => manga.id),
      [1]
    );

    const open = new AnilistAPI();
    const openBodies = stubAnilist(open, () =>
      mangaPage([mangaFixture({ id: 2, isAdult: true })])
    );
    const all = await open.searchMangaTitles('Fake Title', {
      includeAdult: true,
      includeNovels: true,
    });
    assert.deepEqual(openBodies[0].variables, {
      page: 1,
      perPage: 5,
      sort: ['SEARCH_MATCH'],
      search: 'Fake Title',
    });
    assert.deepEqual(
      all.map((manga) => manga.id),
      [2]
    );

    const broken = new AnilistAPI();
    stubAnilist(broken, () => ({ data: { data: { Page: {} } } }));
    await assert.rejects(
      broken.searchMangaTitles('Fake Title', policy),
      (error: unknown) =>
        error instanceof Error && error.name === 'AnilistBadResponseError'
    );
  });
});

describe('AniList manga batch reads', () => {
  it('reads several IDs in one cached request and keeps only requested IDs', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () =>
      mangaPage([
        mangaFixture({ id: 3 }),
        mangaFixture({ id: 1, isAdult: true }),
        mangaFixture({ id: 99 }),
        mangaFixture({ id: 3 }),
        { id: 'broken' },
      ])
    );

    const first = await api.getMangaSummariesByIds([3, 1, 3, 2]);
    const second = await api.getMangaSummariesByIds([2, 1, 3]);

    assert.equal(bodies.length, 1);
    assert.match(bodies[0].query, /id_in: \$ids, type: MANGA/);
    assert.match(bodies[0].query, /perPage: 50/);
    assert.deepEqual(bodies[0].variables, { ids: [1, 2, 3] });
    // The policy is the caller's, so an adult title still comes back.
    assert.deepEqual(
      first.map((manga) => manga.id),
      [3, 1]
    );
    assert.deepEqual(second, first);
    assert.deepEqual(sleeps, []);
  });

  it('spends nothing on an empty list and refuses more than 50 IDs', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () => mangaPage([]));

    assert.deepEqual(await api.getMangaSummariesByIds([]), []);
    await assert.rejects(
      api.getMangaSummariesByIds(Array.from({ length: 51 }, (_, i) => i + 1)),
      RangeError
    );
    assert.equal(bodies.length, 0);
  });

  it('rejects malformed batch pages and reports rate limits', async () => {
    // Replies are cached per ID set, so each case reads its own ID.
    for (const [id, reply] of [
      [1, { data: { data: { Page: null } } }],
      [2, { data: { data: { Page: {} } } }],
      [3, { data: { data: { Page: { media: 'none' } } } }],
    ] as const) {
      const api = new AnilistAPI();
      stubAnilist(api, () => reply);
      await assert.rejects(
        api.getMangaSummariesByIds([id]),
        (error: unknown) =>
          error instanceof Error && error.name === 'AnilistBadResponseError'
      );
    }

    const limited = new AnilistAPI();
    stubAnilist(limited, () => ({
      status: 429,
      data: {},
      headers: { 'retry-after': '30' },
    }));
    await assert.rejects(
      limited.getMangaSummariesByIds([4]),
      rateLimited(30, true)
    );
  });
});

describe('AniList Planning list reads', () => {
  const planningPage = (
    mediaList: unknown[],
    pageInfo: unknown = { hasNextPage: false }
  ): StubResponse => ({ data: { data: { Page: { pageInfo, mediaList } } } });

  it("reads one uncached page of the user's Planning manga with their token", async () => {
    const token = `fake-${randomUUID()}`;
    const api = new AnilistAPI({ accessToken: token });
    const bodies: GraphQlBody[] = [];
    const authorization: unknown[] = [];
    (api as unknown as { axios: AxiosInstance }).axios.defaults.adapter =
      async (config) => {
        authorization.push(config.headers?.Authorization);
        bodies.push(JSON.parse(String(config.data)) as GraphQlBody);
        return toResponse(
          config,
          planningPage(
            [
              {
                updatedAt: 1_700_000_200,
                media: { id: 12, format: 'MANGA', isAdult: false },
              },
              {
                updatedAt: null,
                media: { id: 11, format: 'NOVEL', isAdult: null },
              },
              { updatedAt: 1_700_000_100, media: { id: 10, isAdult: true } },
              { updatedAt: 1_700_000_000, media: null },
              { updatedAt: 1_700_000_000, media: { id: 0 } },
              'row',
            ],
            { hasNextPage: true }
          )
        );
      };

    const page = await api.getMangaPlanningPage(77, 2);
    await api.getMangaPlanningPage(77, 2);

    assert.equal(bodies.length, 2);
    assert.deepEqual(authorization, [`Bearer ${token}`, `Bearer ${token}`]);
    assert.deepEqual(bodies[0].variables, { userId: 77, page: 2 });
    assert.match(bodies[0].query, /^\s*query MangaPlanningPage/);
    assert.doesNotMatch(bodies[0].query, /mutation/i);
    assert.match(
      bodies[0].query,
      /mediaList\(\s*userId: \$userId\s*type: MANGA\s*status: PLANNING/
    );
    assert.match(bodies[0].query, /sort: \[UPDATED_TIME_DESC, MEDIA_ID_DESC\]/);
    assert.match(bodies[0].query, /perPage: 50/);
    assert.deepEqual(page, {
      hasNextPage: true,
      entries: [
        {
          anilistId: 12,
          updatedAt: 1_700_000_200,
          format: 'MANGA',
          isAdult: false,
        },
        { anilistId: 11, updatedAt: 0, format: 'NOVEL', isAdult: false },
        {
          anilistId: 10,
          updatedAt: 1_700_000_100,
          format: undefined,
          isAdult: true,
        },
      ],
    });
  });

  it('rejects malformed Planning pages and reports rate limits', async () => {
    for (const reply of [
      { data: { data: { Page: null } } },
      planningPage([], {}),
      planningPage([], { hasNextPage: 'false' }),
      { data: { data: { Page: { pageInfo: { hasNextPage: false } } } } },
      planningPage(
        Array.from({ length: 51 }, (_, index) => ({
          updatedAt: 1,
          media: { id: index + 1 },
        }))
      ),
    ]) {
      const api = new AnilistAPI();
      stubAnilist(api, () => reply);
      await assert.rejects(
        api.getMangaPlanningPage(77, 1),
        (error: unknown) =>
          error instanceof Error && error.name === 'AnilistBadResponseError'
      );
    }

    const limited = new AnilistAPI();
    stubAnilist(limited, () => ({
      status: 429,
      data: {},
      headers: { 'retry-after': '30' },
    }));
    await assert.rejects(
      limited.getMangaPlanningPage(77, 1),
      rateLimited(30, true)
    );
  });
});

describe('manga detail mapping', () => {
  const details = {
    id: 30013,
    titles: { romaji: 'Example Romaji', english: 'Example Title' },
    synonyms: [],
    isAdult: false,
    genres: [],
    tags: [
      { name: 'Revenge', rank: 80, isSpoiler: false, isAdult: false },
      { name: 'Twist', rank: 50, isSpoiler: true, isAdult: false },
      { name: 'Nudity', rank: 30, isSpoiler: false, isAdult: true },
    ],
    staff: [
      { id: 10, name: 'Writer One', role: 'Story & Art' },
      { id: 11, name: 'Artist Two', role: 'Art (chapters 1-20)' },
      { id: 12, name: 'Translator Three', role: 'Translator (English)' },
      { id: 13, name: 'Creator Four', role: 'Original Creator' },
      { id: 10, name: 'Writer One', role: 'Story (chapters 21-40)' },
    ],
  };

  it('splits story and art credits and hides spoiler and adult tags', () => {
    const mapped = mapMangaDetails(details, {
      includeAdult: false,
      includeNovels: false,
    });

    assert.equal(mapped.mediaType, 'manga');
    assert.equal(mapped.provider, 'anilist');
    assert.equal(mapped.title, 'Example Title');
    assert.deepEqual(mapped.story, [
      { id: 10, name: 'Writer One' },
      { id: 13, name: 'Creator Four' },
    ]);
    assert.deepEqual(mapped.art, [
      { id: 10, name: 'Writer One' },
      { id: 11, name: 'Artist Two' },
    ]);
    assert.deepEqual(mapped.tags, [{ name: 'Revenge', rank: 80 }]);
  });

  it('shows adult tags when adult manga is enabled', () => {
    const mapped = mapMangaDetails(details, {
      includeAdult: true,
      includeNovels: false,
    });

    assert.deepEqual(
      mapped.tags.map((tag) => tag.name),
      ['Revenge', 'Nudity']
    );
  });
});

describe('AniList manga discover filters', () => {
  it('sends each filter with inclusive bounds and keeps the content policy', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () =>
      mangaPage([
        mangaFixture({ id: 1 }),
        mangaFixture({ id: 2, isAdult: true }),
        mangaFixture({ id: 3, format: 'NOVEL' }),
      ])
    );

    const page = await api.getMangaPage(
      pageOptions({
        sort: ['START_DATE_DESC', 'ID_DESC'],
        genre: 'Drama',
        genres: ['Action', 'Comedy'],
        excludedGenres: ['Horror'],
        tags: ['Pirates'],
        excludedTags: ['Time Skip'],
        source: 'WEB_NOVEL',
        startYear: { min: 1990, max: 2005 },
        averageScore: { min: 70, max: 90 },
        chapters: { min: 10, max: 200 },
        volumes: { min: 1, max: 20 },
      })
    );

    assert.deepEqual(bodies[0].variables, {
      page: 1,
      perPage: 20,
      sort: ['START_DATE_DESC', 'ID_DESC'],
      genre: 'Drama',
      formatNotIn: ['NOVEL'],
      isAdult: false,
      genreIn: ['Action', 'Comedy'],
      genreNotIn: ['Horror'],
      tagIn: ['Pirates'],
      tagNotIn: ['Time Skip'],
      source: 'WEB_NOVEL',
      startDateGreater: 19_899_999,
      startDateLesser: 20_059_999,
      averageScoreGreater: 69,
      averageScoreLesser: 91,
      chaptersGreater: 9,
      chaptersLesser: 201,
      volumesGreater: 0,
      volumesLesser: 21,
    });
    for (const [argument, variable] of [
      ['genre_in', 'genreIn'],
      ['genre_not_in', 'genreNotIn'],
      ['tag_in', 'tagIn'],
      ['tag_not_in', 'tagNotIn'],
      ['source', 'source'],
      ['startDate_greater', 'startDateGreater'],
      ['startDate_lesser', 'startDateLesser'],
      ['averageScore_greater', 'averageScoreGreater'],
      ['averageScore_lesser', 'averageScoreLesser'],
      ['chapters_greater', 'chaptersGreater'],
      ['chapters_lesser', 'chaptersLesser'],
      ['volumes_greater', 'volumesGreater'],
      ['volumes_lesser', 'volumesLesser'],
    ]) {
      assert.ok(
        bodies[0].query.includes(`${argument}: $${variable}`),
        argument
      );
      assert.ok(bodies[0].query.includes(`$${variable}:`), variable);
    }
    assert.deepEqual(
      page.media.map((manga) => manga.id),
      [1]
    );
  });

  it('leaves out empty lists and bounds that exclude no known value', async () => {
    const api = new AnilistAPI();
    const bodies = stubAnilist(api, () => mangaPage([]));

    await api.getMangaPage(
      pageOptions({
        includeAdult: true,
        includeNovels: true,
        genres: [],
        excludedTags: [],
        startYear: { min: 1800 },
        averageScore: { min: 0, max: 100 },
        chapters: { min: 0 },
        volumes: { max: 0 },
      })
    );

    assert.deepEqual(bodies[0].variables, {
      page: 1,
      perPage: 20,
      sort: ['TRENDING_DESC'],
      startDateGreater: 17_999_999,
      volumesLesser: 1,
    });
  });

  it('sends a rejected filter again instead of caching the rejection', async () => {
    const api = new AnilistAPI();
    const errors = [{ message: 'Example rejection', status: 400 }];
    let reply: StubResponse = { data: { data: null, errors } };
    const bodies = stubAnilist(api, () => reply);
    const options = pageOptions({ tags: ['Unknown Example Tag'] });

    await assert.rejects(api.getMangaPage(options), AnilistGraphQLError);
    await assert.rejects(api.getMangaPage(options), AnilistGraphQLError);
    assert.equal(bodies.length, 2);

    reply = { status: 400, data: { data: null, errors } };
    await assert.rejects(api.getMangaPage(options), (error: unknown) => {
      assert.ok(axios.isAxiosError(error));
      assert.equal(error.response?.status, 400);
      return true;
    });
    assert.equal(bodies.length, 3);

    reply = mangaPage([mangaFixture()]);
    await api.getMangaPage(options);
    await api.getMangaPage(options);
    assert.equal(bodies.length, 4);
  });
});

describe('AniList manga filter names', () => {
  const catalogReply = (
    overrides: Record<string, unknown> = {}
  ): StubResponse => ({
    data: {
      data: {
        GenreCollection: ['Drama', 'Action', 'Hentai'],
        MediaTagCollection: [
          { name: 'Pirates', isAdult: false },
          { name: 'Example Adult Tag', isAdult: true },
        ],
        ...overrides,
      },
    },
  });

  it('reads the names once a day and asks for nothing else', async () => {
    const first = new AnilistAPI();
    const second = new AnilistAPI();
    const firstBodies = stubAnilist(first, () => catalogReply());
    const secondBodies = stubAnilist(second, () => catalogReply());

    const options = await first.getMangaFilterOptions();
    assert.deepEqual(await second.getMangaFilterOptions(), options);

    assert.equal(firstBodies.length, 1);
    assert.equal(secondBodies.length, 0);
    assert.deepEqual(firstBodies[0].variables, {});
    assert.match(firstBodies[0].query, /GenreCollection/);
    assert.match(firstBodies[0].query, /MediaTagCollection \{ name isAdult \}/);
    assert.doesNotMatch(firstBodies[0].query, /\b(id|description)\b/);
    assert.deepEqual(options, {
      genres: [
        { name: 'Drama', isAdult: false },
        { name: 'Action', isAdult: false },
        { name: 'Hentai', isAdult: true },
      ],
      tags: [
        { name: 'Pirates', isAdult: false },
        { name: 'Example Adult Tag', isAdult: true },
      ],
    });

    const cache = cacheManager.getCache('anilist').data;
    const expiries = cache.keys().map((key) => cache.getTtl(key) ?? 0);
    assert.equal(expiries.length, 1);
    assert.ok(Math.abs(expiries[0] - Date.now() - 86_400_000) < 60_000);
  });

  it('shares one in-flight read between clients', async () => {
    const first = new AnilistAPI();
    const second = new AnilistAPI();
    const firstBodies = stubAnilist(first, () => catalogReply());
    const secondBodies = stubAnilist(second, () => catalogReply());

    const [a, b] = await Promise.all([
      first.getMangaFilterOptions(),
      second.getMangaFilterOptions(),
    ]);

    assert.deepEqual(a, b);
    assert.equal(firstBodies.length + secondBodies.length, 1);
  });

  it('spends the shared AniList budget', async () => {
    const anime = new AnilistAPI();
    const manga = new AnilistAPI();
    stubAnilist(anime, animePage);
    stubAnilist(manga, () => catalogReply());

    await anime.getTrending(1);
    await manga.getMangaFilterOptions();

    assert.deepEqual(sleeps, [1_000]);
  });

  it('caches no failed or malformed reply', async () => {
    const api = new AnilistAPI();
    let reply: StubResponse = { status: 500, data: {} };
    const bodies = stubAnilist(api, () => reply);

    await assert.rejects(api.getMangaFilterOptions(), (error: unknown) =>
      axios.isAxiosError(error)
    );
    reply = { data: { data: { GenreCollection: ['Drama'] } } };
    await assert.rejects(api.getMangaFilterOptions(), AnilistBadResponseError);
    reply = {
      data: {
        data: null,
        errors: [{ message: 'Example failure', status: 400 }],
      },
    };
    await assert.rejects(api.getMangaFilterOptions(), AnilistGraphQLError);
    reply = catalogReply();
    await api.getMangaFilterOptions();
    await api.getMangaFilterOptions();

    assert.equal(bodies.length, 4);
  });

  it('keeps names that pass through the discover parameters unchanged', async () => {
    const api = new AnilistAPI();
    stubAnilist(api, () =>
      catalogReply({
        GenreCollection: [
          ' Drama ',
          'Drama',
          'g'.repeat(65),
          'Comma, Genre',
          '',
          7,
          null,
          'Hentai',
        ],
        MediaTagCollection: [
          { name: 'Pirates', isAdult: false },
          { name: 'Pirates', isAdult: true },
          { name: 'Unflagged Example' },
          { name: 'Text Flag Example', isAdult: 'false' },
          { name: 't'.repeat(65), isAdult: false },
          { name: 'Comma, Tag', isAdult: false },
          'Loose Example',
          null,
        ],
      })
    );

    assert.deepEqual(await api.getMangaFilterOptions(), {
      genres: [
        { name: 'Drama', isAdult: false },
        { name: 'Hentai', isAdult: true },
      ],
      tags: [
        { name: 'Pirates', isAdult: false },
        { name: 'Unflagged Example', isAdult: true },
        { name: 'Text Flag Example', isAdult: true },
      ],
    });
  });

  it('keeps at most 100 genres and 1,000 tags', async () => {
    const api = new AnilistAPI();
    stubAnilist(api, () =>
      catalogReply({
        GenreCollection: Array.from({ length: 150 }, (_, i) => `Genre ${i}`),
        MediaTagCollection: Array.from({ length: 1_200 }, (_, i) => ({
          name: `Tag ${i}`,
          isAdult: false,
        })),
      })
    );

    const options = await api.getMangaFilterOptions();

    assert.equal(options.genres.length, 100);
    assert.equal(options.tags.length, 1_000);
  });
});

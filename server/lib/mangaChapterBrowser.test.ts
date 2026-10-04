import { SuwayomiError } from '@server/api/suwayomi/errors';
import { MangaRequestScope } from '@server/constants/mangaRequest';
import { MediaRequestStatus } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import type Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { MangaChapterPageResponse } from '@server/interfaces/api/mangaChapterInterfaces';
import cacheManager from '@server/lib/cache';
import {
  DEFAULT_MANGA_CHAPTER_PAGE_SIZE,
  getMangaChapterErrorFields,
  getMangaChapterPage,
  parseMangaChapterPaging,
  type MangaChapterViewer,
} from '@server/lib/mangaChapterBrowser';
import { getMangaDownloadAssetId } from '@server/lib/requestDownloadAssets';
import { getSettings, type SuwayomiSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { setupTestDb } from '@server/test/db';
import {
  FAKE_URL_PREFIX,
  dispatchInstanceFor,
  fakeChapterUrl,
  fakeDispatchChapters,
  fakeDispatchManga,
  fakeMangaUrl,
  seedDispatchBinding,
  seedDispatchRequest,
  startFakeDispatchSuwayomi,
  type FakeDispatchManga,
  type FakeDispatchSuwayomi,
} from '@server/test/fakeSuwayomiDispatch';
import { seedProgressRequest } from '@server/test/fakeSuwayomiProgress';
import {
  downloadedManga,
  seedDeliveredRequest,
} from '@server/test/mangaDownloadCopies';
import { AxiosError, AxiosHeaders } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

setupTestDb();

const settings = getSettings();
const fakes: FakeDispatchSuwayomi[] = [];
const chapterCache = () => cacheManager.getCache('suwayomichapters');

/** Requester of every seeded request. */
const OWNER: MangaChapterViewer = { id: 2, canViewAll: false };
const STRANGER: MangaChapterViewer = { id: 3, canViewAll: false };
const REQUEST_VIEWER: MangaChapterViewer = { id: 3, canViewAll: true };
const FIRST_PAGE = { page: 1, pageSize: 50 };
const READ_OPERATIONS = [
  'ByNaturalKey',
  'ChaptersToDownload',
  'DownloadedChapters',
];

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

/** A fake serving `mangas` as instance 1, the only configured instance. */
const start = async (...mangas: FakeDispatchManga[]) => {
  const fake = await startFakeDispatchSuwayomi(mangas);
  fakes.push(fake);
  configure(dispatchInstanceFor(fake.server));
  return fake;
};

/** A library manga bound to AniList title 9001 on instance 1. */
const startBound = async (manga: FakeDispatchManga) => {
  const fake = await start(manga);
  await seedDispatchBinding(manga);
  return fake;
};

const view = (viewer: MangaChapterViewer = OWNER, paging = FIRST_PAGE) =>
  getMangaChapterPage(9001, viewer, paging);

const statesOf = (page: MangaChapterPageResponse) =>
  page.results.map(({ number, status }) => [number, status]);

/** Every request is a read the chapter list may send; none is a write. */
const assertReadsOnly = (fake: FakeDispatchSuwayomi) => {
  for (const request of fake.server.requests) {
    assert.strictEqual(request.method, 'POST');
    assert.ok(
      READ_OPERATIONS.includes(request.operationName ?? ''),
      `Unexpected Suwayomi operation ${String(request.operationName)}`
    );
    assert.match(request.query ?? '', /^\s*query /);
  }
  assert.deepStrictEqual(fake.writes(), []);
};

const decline = (requestId: number) =>
  dataSource
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status: MediaRequestStatus.DECLINED })
    .where({ id: requestId })
    .callListeners(false)
    .execute();

beforeEach(() => {
  chapterCache().flush();
  configure();
});

afterEach(async () => {
  configure();
  chapterCache().flush();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

describe('manga chapter paging', () => {
  it('defaults to the first page of 50 and accepts numbers and digit strings', () => {
    assert.deepStrictEqual(parseMangaChapterPaging({}), {
      page: 1,
      pageSize: DEFAULT_MANGA_CHAPTER_PAGE_SIZE,
    });
    assert.deepStrictEqual(
      parseMangaChapterPaging({ page: '3', pageSize: '100' }),
      { page: 3, pageSize: 100 }
    );
    assert.deepStrictEqual(
      parseMangaChapterPaging({ page: 10_000, pageSize: 1 }),
      { page: 10_000, pageSize: 1 }
    );
  });

  it('rejects values outside the bounds instead of clamping them', () => {
    for (const page of [
      '0',
      '-1',
      '1.5',
      'x',
      '',
      ' 1',
      '10001',
      0,
      1.5,
      10_001,
      ['1', '2'],
    ]) {
      assert.deepStrictEqual(
        parseMangaChapterPaging({ page }),
        { error: 'page must be an integer from 1 to 10000.' },
        JSON.stringify(page)
      );
    }
    for (const pageSize of ['0', '101', 'x', 0, 101, ['50']]) {
      assert.deepStrictEqual(
        parseMangaChapterPaging({ pageSize }),
        { error: 'pageSize must be an integer from 1 to 100.' },
        JSON.stringify(pageSize)
      );
    }
  });
});

describe('manga chapter error fields', () => {
  it('keeps codes and names and never a message', () => {
    assert.deepStrictEqual(
      getMangaChapterErrorFields(
        new SuwayomiError('HTTP_ERROR', 'ByNaturalKey', { httpStatus: 502 })
      ),
      { code: 'HTTP_ERROR', operation: 'ByNaturalKey', httpStatus: 502 }
    );
    assert.deepStrictEqual(
      getMangaChapterErrorFields(new Error('private detail')),
      { errorName: 'Error' }
    );
    assert.deepStrictEqual(
      getMangaChapterErrorFields(
        new AxiosError(
          'private detail',
          'ERR_BAD_RESPONSE',
          undefined,
          undefined,
          {
            status: 502,
            statusText: 'private detail',
            headers: {},
            config: { headers: new AxiosHeaders() },
            data: { message: 'private detail' },
          }
        )
      ),
      { errorName: 'AxiosError', errorCode: 'ERR_BAD_RESPONSE', status: 502 }
    );
  });
});

describe('chapters of a library entry', () => {
  it('lists stored chapters by number, highest first, without contacting a source', async () => {
    const manga = fakeDispatchManga(21, {
      inLibrary: true,
      chapters: [
        {
          id: 2101,
          url: fakeChapterUrl(21, 1),
          chapterNumber: 1,
          scanlator: 'Fake Group',
          uploadDate: Date.UTC(2024, 0, 2),
          isDownloaded: true,
        },
        {
          id: 2190,
          url: `${FAKE_URL_PREFIX}manga-21/extra`,
          chapterNumber: -1,
          uploadDate: 0,
          isDownloaded: false,
        },
        {
          id: 2102,
          url: fakeChapterUrl(21, 2),
          chapterNumber: 2,
          uploadDate: Date.UTC(2024, 0, 9),
          isDownloaded: false,
        },
        {
          id: 2122,
          url: `${fakeChapterUrl(21, 2)}-b`,
          chapterNumber: 2,
          uploadDate: Date.UTC(2024, 0, 10),
          isDownloaded: true,
        },
        {
          id: 2110,
          url: fakeChapterUrl(21, 10.5),
          chapterNumber: 10.5,
          uploadDate: Date.UTC(2024, 1, 1),
          isDownloaded: false,
        },
      ],
    });
    const fake = await startBound(manga);

    const page = await view();

    assert.deepStrictEqual(page, {
      pageInfo: { page: 1, pages: 1, pageSize: 50, results: 5 },
      inLibrary: true,
      results: [
        {
          number: 10.5,
          name: 'Fake Chapter 10.5',
          uploadedAt: '2024-02-01T00:00:00.000Z',
          status: 'notRequested',
        },
        {
          number: 2,
          name: 'Fake Chapter 2',
          uploadedAt: '2024-01-10T00:00:00.000Z',
          status: 'available',
        },
        {
          number: 2,
          name: 'Fake Chapter 2',
          uploadedAt: '2024-01-09T00:00:00.000Z',
          status: 'notRequested',
        },
        {
          number: 1,
          name: 'Fake Chapter 1',
          uploadedAt: '2024-01-02T00:00:00.000Z',
          status: 'available',
        },
        {
          number: null,
          name: 'Fake Chapter -1',
          uploadedAt: null,
          status: 'notRequested',
        },
      ],
    });
    const body = JSON.stringify(page);
    assert.ok(!body.includes(FAKE_URL_PREFIX));
    assert.ok(!body.includes('Fake Group'));
    assert.deepStrictEqual(fake.operationNames().sort(), READ_OPERATIONS);
    assertReadsOnly(fake);
  });

  it('answers an empty first page for an entry without chapters', async () => {
    await startBound(fakeDispatchManga(21, { inLibrary: true, chapters: [] }));

    assert.deepStrictEqual(await view(), {
      pageInfo: { page: 1, pages: 1, pageSize: 50, results: 0 },
      inLibrary: true,
      results: [],
    });
  });

  it('pages the list and answers an empty page past the end', async () => {
    await startBound(
      fakeDispatchManga(21, {
        inLibrary: true,
        chapters: fakeDispatchChapters(21, [1, 2, 3, 4, 5]),
      })
    );

    const second = await view(OWNER, { page: 2, pageSize: 2 });
    assert.deepStrictEqual(second.pageInfo, {
      page: 2,
      pages: 3,
      pageSize: 2,
      results: 5,
    });
    assert.deepStrictEqual(
      second.results.map(({ number }) => number),
      [3, 2]
    );

    const past = await view(OWNER, { page: 9, pageSize: 2 });
    assert.deepStrictEqual(past.pageInfo, {
      page: 9,
      pages: 3,
      pageSize: 2,
      results: 5,
    });
    assert.deepStrictEqual(past.results, []);
  });

  it('serves repeat and concurrent views from one short-lived read', async () => {
    const manga = fakeDispatchManga(21, { inLibrary: true });
    const fake = await startBound(manga);

    const [first, second] = await Promise.all([view(), view(STRANGER)]);
    await view(OWNER, { page: 2, pageSize: 1 });

    assert.deepStrictEqual(first, second);
    assert.strictEqual(fake.operationNames().length, 3);
    const [key] = chapterCache().data.keys();
    const ttl = chapterCache().data.getTtl(key) ?? 0;
    assert.ok(ttl > Date.now() && ttl <= Date.now() + 60_000);

    // Once the entry expires, the next view reads the stored list again.
    manga.chapters[0].isDownloaded = true;
    chapterCache().data.del(key);
    assert.deepStrictEqual(statesOf(await view()), [
      [3, 'notRequested'],
      [2, 'notRequested'],
      [1, 'available'],
    ]);
    assert.strictEqual(fake.operationNames().length, 6);
    assertReadsOnly(fake);
  });

  it('does not keep a failed read', async () => {
    const fake = await startBound(fakeDispatchManga(21, { inLibrary: true }));
    fake.fault('DownloadedChapters', 'error');

    await assert.rejects(view(), SuwayomiError);
    assert.deepStrictEqual(chapterCache().data.keys(), []);
    assert.strictEqual((await view()).pageInfo.results, 3);
    assert.strictEqual(
      fake.operationNames().filter((name) => name === 'ByNaturalKey').length,
      2
    );
  });

  it('falls back to requested chapters once Suwayomi no longer has the entry, and remembers that', async () => {
    const fake = await start();
    const manga = fakeDispatchManga(21, { inLibrary: true });
    await seedDispatchBinding(manga);
    await seedProgressRequest(manga, { numbers: [2] });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepStrictEqual(await view(), {
        pageInfo: { page: 1, pages: 1, pageSize: 50, results: 1 },
        inLibrary: false,
        results: [
          { number: 2, name: '', uploadedAt: null, status: 'requested' },
        ],
      });
    }
    assert.deepStrictEqual(fake.operationNames(), ['ByNaturalKey']);
  });

  it('reads the default instance first and skips entries it may not use', async () => {
    const first = fakeDispatchManga(31, {
      inLibrary: true,
      chapters: fakeDispatchChapters(31, [1]),
    });
    const second = fakeDispatchManga(32, {
      inLibrary: true,
      chapters: fakeDispatchChapters(32, [1, 2]),
    });
    const outside = fakeDispatchManga(33, {
      chapters: fakeDispatchChapters(33, [1, 2, 3]),
    });
    const orphaned = fakeDispatchManga(34, {
      inLibrary: true,
      chapters: fakeDispatchChapters(34, [1, 2, 3, 4]),
    });
    const fake = await startFakeDispatchSuwayomi([
      first,
      second,
      outside,
      orphaned,
    ]);
    fakes.push(fake);
    await seedDispatchBinding(first, { instanceId: 1 });
    await seedDispatchBinding(second, { instanceId: 2 });
    await seedDispatchBinding(outside, { instanceId: 2 });
    await seedDispatchBinding(orphaned, {
      instanceId: 2,
      state: MangaBindingState.ORPHANED,
    });
    await seedDispatchBinding(fakeDispatchManga(35, { inLibrary: true }), {
      instanceId: 3,
    });
    const lookups = () =>
      fake.server.requests
        .filter(({ operationName }) => operationName === 'ByNaturalKey')
        .map(({ variables }) => variables.url);

    configure(
      dispatchInstanceFor(fake.server, 1, { isDefault: false }),
      dispatchInstanceFor(fake.server, 2, { isDefault: true })
    );
    assert.strictEqual((await view()).pageInfo.results, 2);

    configure(
      dispatchInstanceFor(fake.server, 1),
      dispatchInstanceFor(fake.server, 2)
    );
    assert.strictEqual((await view()).pageInfo.results, 1);
    assert.deepStrictEqual(lookups(), [fakeMangaUrl(32), fakeMangaUrl(31)]);
  });

  it('looks up at most five library entries per view', async () => {
    const fake = await start();
    for (let id = 41; id <= 46; id += 1) {
      await seedDispatchBinding(fakeDispatchManga(id, { inLibrary: true }));
    }

    const page = await view();

    assert.strictEqual(page.inLibrary, false);
    assert.deepStrictEqual(fake.operationNames(), [
      'ByNaturalKey',
      'ByNaturalKey',
      'ByNaturalKey',
      'ByNaturalKey',
      'ByNaturalKey',
    ]);
  });

  it('marks the chapters of requests the viewer may see', async () => {
    const manga = fakeDispatchManga(21, {
      inLibrary: true,
      chapters: fakeDispatchChapters(21, [1, 2, 3, 4, 5], [1]),
    });
    await startBound(manga);
    const own = await seedProgressRequest(manga, { numbers: [2] });
    await seedProgressRequest(manga, {
      numbers: [3],
      status: MediaRequestStatus.DECLINED,
      media: own.media,
    });
    // A request frozen on another source counts by chapter number.
    await seedProgressRequest(
      fakeDispatchManga(22, { chapters: fakeDispatchChapters(22, [4]) }),
      { numbers: [4], media: own.media }
    );

    const requested = [
      [5, 'notRequested'],
      [4, 'requested'],
      [3, 'notRequested'],
      [2, 'requested'],
      [1, 'available'],
    ];
    assert.deepStrictEqual(statesOf(await view(OWNER)), requested);
    assert.deepStrictEqual(statesOf(await view(REQUEST_VIEWER)), requested);
    assert.deepStrictEqual(statesOf(await view(STRANGER)), [
      [5, 'notRequested'],
      [4, 'notRequested'],
      [3, 'notRequested'],
      [2, 'notRequested'],
      [1, 'available'],
    ]);
  });

  it('marks the chapters a request would pick before it picks them', async () => {
    const manga = fakeDispatchManga(21, {
      inLibrary: true,
      chapters: fakeDispatchChapters(21, [1, 2, 3, 4, 5], [1]),
    });
    await startBound(manga);
    let media: Media | undefined;
    const cases: [Parameters<typeof seedDispatchRequest>[0], string[]][] = [
      [
        { manifest: { scope: MangaRequestScope.LATEST_N, latestCount: 2 } },
        ['requested', 'requested', 'notRequested', 'notRequested'],
      ],
      [
        {
          manifest: {
            scope: MangaRequestScope.RANGE,
            rangeStart: 2,
            rangeEnd: 3,
          },
        },
        ['notRequested', 'notRequested', 'requested', 'requested'],
      ],
      [{}, ['requested', 'requested', 'requested', 'requested']],
    ];

    for (const [options, expected] of cases) {
      const seeded = await seedDispatchRequest({ ...options, media });
      media = seeded.media;
      const page = await view();
      assert.deepStrictEqual(
        page.results.map(({ status }) => status),
        [...expected, 'available'],
        JSON.stringify(options)
      );
      await decline(seeded.request.id);
    }
  });

  it('previews duplicate chapter numbers with the server scanlator preference', async () => {
    const manga = fakeDispatchManga(21, {
      inLibrary: true,
      chapters: [
        {
          id: 2102,
          url: fakeChapterUrl(21, 2),
          chapterNumber: 2,
          scanlator: 'Group A',
          isDownloaded: false,
        },
        {
          id: 2122,
          url: `${fakeChapterUrl(21, 2)}-b`,
          chapterNumber: 2,
          scanlator: 'Group B',
          isDownloaded: false,
        },
      ],
    });
    const fake = await startBound(manga);
    configure(
      dispatchInstanceFor(fake.server, 1, { scanlatorPreference: ['Group A'] })
    );
    await seedDispatchRequest({
      manifest: { scope: MangaRequestScope.LATEST_N, latestCount: 1 },
    });

    // The later source entry lists first; the preferred group is the other.
    assert.deepStrictEqual(
      (await view()).results.map(({ status }) => status),
      ['notRequested', 'requested']
    );
  });

  it('links verified chapters to the download route of the newest request offering them', async () => {
    const manga = downloadedManga(21, [1, 2]);
    manga.chapters.push(...fakeDispatchChapters(21, [3]));
    await start(manga);
    const older = await seedDeliveredRequest(manga, { numbers: [1, 2] });
    const newer = await seedDeliveredRequest(manga, {
      numbers: [2],
      binding: null,
      media: older.media,
    });
    const link = (requestId: number, chapterNumber: number) => ({
      requestId,
      assetId: getMangaDownloadAssetId(requestId, {
        instanceId: 1,
        urlHash: hashMangaSourceUrl(fakeChapterUrl(21, chapterNumber)),
      }),
    });
    const linksOf = (page: MangaChapterPageResponse) =>
      page.results.map(({ number, status, download }) => ({
        number,
        status,
        download,
      }));

    assert.deepStrictEqual(linksOf(await view()), [
      { number: 3, status: 'notRequested', download: undefined },
      { number: 2, status: 'available', download: link(newer.request.id, 2) },
      { number: 1, status: 'available', download: link(older.request.id, 1) },
    ]);
    assert.deepStrictEqual(linksOf(await view(STRANGER)), [
      { number: 3, status: 'notRequested', download: undefined },
      { number: 2, status: 'available', download: undefined },
      { number: 1, status: 'available', download: undefined },
    ]);
    assert.deepStrictEqual(
      linksOf(await view(REQUEST_VIEWER)),
      linksOf(await view())
    );
  });

  it('offers no link for a copy the download route would refuse', async () => {
    const manga = downloadedManga(21, [1, 2, 3, 4]);
    const fake = await start(manga);
    const offered = await seedDeliveredRequest(manga, { numbers: [1] });
    await seedDeliveredRequest(manga, {
      numbers: [2],
      delivered: false,
      binding: null,
      media: offered.media,
    });
    const missing = await seedDeliveredRequest(manga, {
      numbers: [3],
      binding: null,
      media: offered.media,
    });
    await getRepository(MangaRequestChapter).update(missing.rows[0].id, {
      missingSince: new Date(),
    });
    await seedDeliveredRequest(manga, {
      numbers: [4],
      status: MediaRequestStatus.PENDING,
      binding: null,
      media: offered.media,
    });
    const linked = async () =>
      (await view()).results.map(({ number, download }) => [
        number,
        download?.requestId ?? null,
      ]);

    assert.deepStrictEqual(await linked(), [
      [4, null],
      [3, null],
      [2, null],
      [1, offered.request.id],
    ]);

    configure(dispatchInstanceFor(fake.server, 1, { requireCbz: false }));
    assert.deepStrictEqual(await linked(), [
      [4, null],
      [3, null],
      [2, null],
      [1, null],
    ]);
  });
});

describe('chapters of a title outside the library', () => {
  it('lists the chapters of visible requests without contacting Suwayomi', async () => {
    const fake = await start();
    const manga = fakeDispatchManga(21, {
      chapters: [
        ...fakeDispatchChapters(21, [1, 2, 3]),
        {
          id: 2190,
          url: `${FAKE_URL_PREFIX}manga-21/extra`,
          chapterNumber: -1,
          isDownloaded: false,
        },
      ],
    });
    const first = await seedProgressRequest(manga, { numbers: [1, 2, -1] });
    await seedProgressRequest(
      fakeDispatchManga(22, { chapters: fakeDispatchChapters(22, [2, 4]) }),
      { numbers: [2, 4], media: first.media }
    );
    // Not dispatched yet, so it holds no chapters.
    await seedDispatchRequest({ media: first.media });
    const declined = await seedProgressRequest(manga, {
      numbers: [3],
      media: first.media,
    });
    await decline(declined.request.id);

    const requested = (numbers: (number | null)[]) =>
      numbers.map((number) => ({
        number,
        name: '',
        uploadedAt: null,
        status: 'requested',
      }));
    assert.deepStrictEqual(await view(), {
      pageInfo: { page: 1, pages: 1, pageSize: 50, results: 4 },
      inLibrary: false,
      results: requested([4, 2, 1, null]),
    });
    assert.deepStrictEqual(
      await view(REQUEST_VIEWER, { page: 2, pageSize: 3 }),
      {
        pageInfo: { page: 2, pages: 2, pageSize: 3, results: 4 },
        inLibrary: false,
        results: requested([null]),
      }
    );
    assert.deepStrictEqual(await view(STRANGER), {
      pageInfo: { page: 1, pages: 1, pageSize: 50, results: 0 },
      inLibrary: false,
      results: [],
    });
    assert.deepStrictEqual(fake.server.requests, []);
  });
});

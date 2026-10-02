import SuwayomiAPI from '@server/api/suwayomi';
import logger from '@server/logger';
import {
  fakeLibraryManga,
  graphqlData,
  serveFakeLibrary,
  startFakeSuwayomi,
  type FakeLibraryManga,
  type FakeReply,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

const servers: FakeSuwayomi[] = [];

const start = async () => {
  const server = await startFakeSuwayomi({ mode: 'NONE' });
  servers.push(server);
  return server;
};

const connect = (server: FakeSuwayomi) =>
  new SuwayomiAPI({ url: server.url, auth: { mode: 'NONE' } });

/** One raw LibraryPage reply. */
const page = (
  nodes: unknown[],
  {
    totalCount = nodes.length as unknown,
    hasNextPage = false as unknown,
    endCursor = null as unknown,
  } = {}
): FakeReply =>
  graphqlData({
    mangas: { totalCount, pageInfo: { hasNextPage, endCursor }, nodes },
  });

const node = (
  manga: FakeLibraryManga,
  overrides: Record<string, unknown> = {}
) => ({
  id: manga.id,
  sourceId: manga.sourceId,
  url: manga.url,
  title: manga.title,
  downloadCount: 0,
  hasDuplicateChapters: false,
  chapters: { totalCount: 0 },
  ...overrides,
});

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('SuwayomiAPI library listing', () => {
  it('follows keyset pages in ID order and reports a consistent listing', async () => {
    const server = await start();
    serveFakeLibrary(server, {
      mangas: [5, 1, 4, 2, 3].map((id) =>
        fakeLibraryManga(id, { chapterCount: 3, downloadCount: id % 4 })
      ),
      pageSize: 2,
    });

    const listing = await connect(server).listLibrary();

    assert.deepEqual(listing.items[0], {
      id: '1',
      sourceId: '0',
      url: '/fake-library/1',
      title: 'Fake Library Title 1',
      downloadCount: 1,
      chapterCount: 3,
      hasDuplicateChapters: false,
    });
    assert.deepEqual(
      listing.items.map(({ id }) => id),
      ['1', '2', '3', '4', '5']
    );
    assert.equal(listing.consistent, true);
    assert.equal(listing.skippedUrls, 0);
    assert.equal(listing.duplicateNaturalKeys, 0);
    assert.deepEqual(
      server.operations('LibraryPage').map(({ variables }) => variables),
      [{ after: null }, { after: '2' }, { after: '4' }]
    );
  });

  it('reads an empty library as consistent', async () => {
    const server = await start();
    serveFakeLibrary(server, { mangas: [] });
    assert.deepEqual(await connect(server).listLibrary(), {
      items: [],
      consistent: true,
      skippedUrls: 0,
      duplicateNaturalKeys: 0,
    });
  });

  it('marks a repeated ID, a changed total or a missing manga inconsistent', async () => {
    const [a, b, c] = [1, 2, 3].map((id) => fakeLibraryManga(id));
    const cases: [string, FakeReply[]][] = [
      [
        'repeated ID',
        [
          page([node(a), node(b)], {
            totalCount: 3,
            hasNextPage: true,
            endCursor: '2',
          }),
          page([node(b, { url: '/moved' }), node(c)], { totalCount: 3 }),
        ],
      ],
      [
        'changed total',
        [
          page([node(a)], { totalCount: 2, hasNextPage: true, endCursor: '1' }),
          page([node(b)], { totalCount: 3 }),
        ],
      ],
      ['missing manga', [page([node(a), node(b)], { totalCount: 3 })]],
    ];
    for (const [label, replies] of cases) {
      const server = await start();
      server.onOperation('LibraryPage', ...replies);
      const listing = await connect(server).listLibrary();
      assert.equal(listing.consistent, false, label);
      assert.ok(
        listing.items.some(({ id }) => id === '2'),
        `${label}: the items are still listed`
      );
    }

    const server = await start();
    server.onOperation('LibraryPage', ...cases[0][1]);
    assert.deepEqual(
      (await connect(server).listLibrary()).items.map(({ url }) => url),
      [a.url, b.url, c.url],
      'the first listing of a repeated ID wins'
    );
  });

  it('keeps the lowest ID of a duplicate source and URL without losing consistency', async () => {
    const server = await start();
    const shared = { sourceId: '7', url: '/fake-library/shared' };
    serveFakeLibrary(server, {
      mangas: [
        fakeLibraryManga(9, shared),
        fakeLibraryManga(3, shared),
        fakeLibraryManga(4, { ...shared, sourceId: '8' }),
      ],
      pageSize: 1,
    });
    const listing = await connect(server).listLibrary();
    assert.deepEqual(
      listing.items.map(({ id, sourceId }) => [id, sourceId]),
      [
        ['3', '7'],
        ['4', '8'],
      ]
    );
    assert.equal(listing.duplicateNaturalKeys, 1);
    assert.equal(listing.consistent, true);
  });

  it('skips URLs it cannot store but still counts them toward consistency', async () => {
    const server = await start();
    serveFakeLibrary(server, {
      mangas: [
        fakeLibraryManga(1, { url: `/${'u'.repeat(2_048)}` }),
        fakeLibraryManga(2, { url: '/fake\r\nline' }),
        fakeLibraryManga(3, { url: `/${'u'.repeat(2_047)}` }),
      ],
    });
    const logs: unknown[] = [];
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      mock.method(logger, level, (...args: unknown[]) => {
        logs.push(args);
        return logger;
      });
    }
    const listing = await connect(server).listLibrary();
    assert.deepEqual(
      listing.items.map(({ id, url }) => [id, url.length]),
      [['3', 2_048]]
    );
    assert.equal(listing.skippedUrls, 2);
    assert.equal(listing.consistent, true);
    assert.equal(inspect(logs, { depth: 10 }).includes('uuuu'), false);
  });

  it('truncates titles to 512 code points without splitting a character', async () => {
    const server = await start();
    serveFakeLibrary(server, {
      mangas: [
        fakeLibraryManga(1, { title: '\u{1F4D6}'.repeat(600) }),
        fakeLibraryManga(2, { title: `a${'\u{1F4D6}'.repeat(600)}` }),
        fakeLibraryManga(3, { title: ' Fake\r\nTitle ' }),
        fakeLibraryManga(4, { title: 42 as never }),
      ],
    });
    const titles = (await connect(server).listLibrary()).items.map(
      ({ title }) => title
    );
    assert.equal(titles[0], '\u{1F4D6}'.repeat(512));
    assert.equal(titles[1], `a${'\u{1F4D6}'.repeat(511)}`);
    assert.equal(titles[2], 'Fake  Title');
    assert.equal(titles[3], '');
  });

  it('fails the whole listing on an item it cannot trust', async () => {
    const valid = fakeLibraryManga(1);
    const cases: [string, Record<string, unknown>][] = [
      ['empty URL', { url: '' }],
      ['missing URL', { url: undefined }],
      ['text ID', { id: 'one' }],
      ['ID above the Int range', { id: 2_147_483_648 }],
      ['negative ID', { id: -1 }],
      ['negative source', { sourceId: '-5' }],
      ['missing source', { sourceId: null }],
      ['missing download count', { downloadCount: undefined }],
      ['negative download count', { downloadCount: -1 }],
      ['fractional chapter count', { chapters: { totalCount: 1.5 } }],
      ['missing chapters', { chapters: undefined }],
      ['text duplicate flag', { hasDuplicateChapters: 'false' }],
    ];
    for (const [label, overrides] of cases) {
      const server = await start();
      server.onOperation('LibraryPage', page([node(valid, overrides)]));
      await assert.rejects(
        connect(server).listLibrary(),
        { code: 'BAD_RESPONSE' },
        label
      );
    }
  });

  it('fails the whole listing on a page list it cannot follow', async () => {
    const manga = node(fakeLibraryManga(1));
    const cases: [string, FakeReply[]][] = [
      [
        'missing page info',
        [graphqlData({ mangas: { totalCount: 1, nodes: [manga] } })],
      ],
      ['text hasNextPage', [page([manga], { hasNextPage: 'false' })]],
      ['missing total', [page([manga], { totalCount: null })]],
      ['negative total', [page([manga], { totalCount: -1 })]],
      ['missing cursor', [page([manga], { hasNextPage: true })]],
      ['empty cursor', [page([manga], { hasNextPage: true, endCursor: '' })]],
      [
        'oversized cursor',
        [page([manga], { hasNextPage: true, endCursor: 'c'.repeat(257) })],
      ],
      [
        'repeated cursor',
        [
          page([manga], { hasNextPage: true, endCursor: '1' }),
          page([], { totalCount: 1, hasNextPage: true, endCursor: '1' }),
        ],
      ],
      ['missing list', [graphqlData({ mangas: null })]],
    ];
    for (const [label, replies] of cases) {
      const server = await start();
      server.onOperation('LibraryPage', ...replies);
      await assert.rejects(
        connect(server).listLibrary(),
        { code: 'BAD_RESPONSE' },
        label
      );
    }
  });

  it('gives up after 200 pages instead of following an endless list', async () => {
    const server = await start();
    let next = 0;
    server.onOperation('LibraryPage', () => {
      next += 1;
      return page([], { hasNextPage: true, endCursor: String(next) });
    });
    await assert.rejects(connect(server).listLibrary(), {
      code: 'BAD_RESPONSE',
    });
    assert.equal(server.operations('LibraryPage').length, 200);
  });

  it('stops when the caller aborts, mid-request or between pages', async () => {
    const server = await start();
    server.onOperation('LibraryPage', { hang: true });
    const controller = new AbortController();
    const pending = connect(server).listLibrary({ signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, { code: 'ABORTED' });

    const paged = await start();
    const between = new AbortController();
    paged.onOperation('LibraryPage', () => {
      between.abort();
      return page([node(fakeLibraryManga(1))], {
        totalCount: 2,
        hasNextPage: true,
        endCursor: '1',
      });
    });
    await assert.rejects(
      connect(paged).listLibrary({ signal: between.signal }),
      { code: 'ABORTED' }
    );
    assert.equal(paged.operations('LibraryPage').length, 1);
  });
});

describe('SuwayomiAPI library track records', () => {
  it('returns tracker and remote IDs per manga', async () => {
    const server = await start();
    serveFakeLibrary(server, {
      mangas: [
        fakeLibraryManga(1, {
          trackRecords: [
            { trackerId: 2, remoteId: '30013' },
            { trackerId: 1, remoteId: '9223372036854775807' },
          ],
        }),
        fakeLibraryManga(2),
        fakeLibraryManga(3, {
          trackRecords: [{ trackerId: 2, remoteId: '7' }],
        }),
      ],
    });
    assert.deepEqual(await connect(server).getTrackRecords(['1', '2', '1']), [
      {
        mangaId: '1',
        records: [
          { trackerId: 2, remoteId: '30013' },
          { trackerId: 1, remoteId: '9223372036854775807' },
        ],
      },
      { mangaId: '2', records: [] },
    ]);
    assert.deepEqual(server.operations('LibraryTrackRecords')[0].variables, {
      ids: [1, 2],
    });
  });

  it('fails a batch with a record it cannot read', async () => {
    const cases: [string, unknown][] = [
      ['text tracker', { nodes: [{ trackerId: '2', remoteId: '1' }] }],
      ['negative tracker', { nodes: [{ trackerId: -2, remoteId: '1' }] }],
      ['text remote ID', { nodes: [{ trackerId: 2, remoteId: 'x1' }] }],
      ['missing remote ID', { nodes: [{ trackerId: 2 }] }],
      ['missing records', null],
    ];
    for (const [label, trackRecords] of cases) {
      const server = await start();
      server.onOperation(
        'LibraryTrackRecords',
        graphqlData({ mangas: { nodes: [{ id: 1, trackRecords }] } })
      );
      await assert.rejects(
        connect(server).getTrackRecords(['1']),
        { code: 'BAD_RESPONSE' },
        label
      );
    }
  });

  it('refuses an empty, oversized or invalid ID list before sending', async () => {
    const server = await start();
    const api = connect(server);
    const calls: [string, () => Promise<unknown>][] = [
      ['no IDs', () => api.getTrackRecords([])],
      [
        '101 IDs',
        () =>
          api.getTrackRecords(Array.from({ length: 101 }, (_, i) => `${i}`)),
      ],
      ['exponent ID', () => api.getLibraryChapterStates(['1e3'])],
      ['Int overflow', () => api.getLibraryChapterStates(['2147483648'])],
    ];
    for (const [label, call] of calls) {
      await assert.rejects(call(), { code: 'INVALID_ARGUMENT' }, label);
    }
    assert.equal(server.requests.length, 0);
  });
});

describe('SuwayomiAPI library chapter states', () => {
  it('returns the stored number and download state of every chapter', async () => {
    const server = await start();
    const chapters = [
      { chapterNumber: 1, isDownloaded: true },
      { chapterNumber: 1, isDownloaded: false },
      { chapterNumber: -1, isDownloaded: false },
      { chapterNumber: 2.5, isDownloaded: true },
    ];
    serveFakeLibrary(server, {
      mangas: [
        fakeLibraryManga(4, { chapters, hasDuplicateChapters: true }),
        fakeLibraryManga(5),
      ],
    });
    assert.deepEqual(
      await connect(server).getLibraryChapterStates(['4', '5']),
      [
        { mangaId: '4', totalCount: 4, chapters },
        { mangaId: '5', totalCount: 0, chapters: [] },
      ]
    );
  });

  it('fails a batch with a chapter it cannot read', async () => {
    const cases: [string, unknown][] = [
      [
        'text number',
        { totalCount: 1, nodes: [{ chapterNumber: '1', isDownloaded: true }] },
      ],
      ['missing number', { totalCount: 1, nodes: [{ isDownloaded: true }] }],
      [
        'text state',
        { totalCount: 1, nodes: [{ chapterNumber: 1, isDownloaded: 'true' }] },
      ],
      ['missing total', { nodes: [] }],
      ['missing nodes', { totalCount: 0 }],
    ];
    for (const [label, chapters] of cases) {
      const server = await start();
      server.onOperation(
        'LibraryChapterStates',
        graphqlData({ mangas: { nodes: [{ id: 1, chapters }] } })
      );
      await assert.rejects(
        connect(server).getLibraryChapterStates(['1']),
        { code: 'BAD_RESPONSE' },
        label
      );
    }
  });
});

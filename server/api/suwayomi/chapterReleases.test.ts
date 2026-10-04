import SuwayomiAPI from '@server/api/suwayomi';
import {
  graphqlData,
  startFakeSuwayomi,
  type FakeReply,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const servers: FakeSuwayomi[] = [];

const start = async () => {
  const server = await startFakeSuwayomi({ mode: 'NONE' });
  servers.push(server);
  return server;
};

const connect = (server: FakeSuwayomi) =>
  new SuwayomiAPI({ url: server.url, auth: { mode: 'NONE' } });

// Half a second past whole seconds, so the fetched-at bounds have to round.
const FROM = 1_700_000_000_500;
const BEFORE = FROM + 86_400_000;
const WINDOW = { from: new Date(FROM), before: new Date(BEFORE) };

interface ListPage {
  nodes?: unknown[];
  hasNextPage?: unknown;
  endCursor?: unknown;
}

const list = ({
  nodes = [],
  hasNextPage = false,
  endCursor = null,
}: ListPage) => ({
  pageInfo: { hasNextPage, endCursor },
  nodes,
});

/** One raw ChapterReleases reply. */
const page = (
  uploaded: ListPage,
  undated: ListPage = {},
  mangas: unknown[] = [{ id: 1, sourceId: '0', url: '/title-1' }]
): FakeReply =>
  graphqlData({
    mangas: { nodes: mangas },
    uploaded: list(uploaded),
    undated: list(undated),
  });

const dated = (id: number, uploadDate: unknown, overrides = {}) => ({
  id,
  mangaId: 1,
  chapterNumber: id,
  uploadDate,
  fetchedAt: '1700000100',
  isDownloaded: false,
  ...overrides,
});

const undated = (id: number, fetchedAt: unknown, overrides = {}) => ({
  id,
  mangaId: 1,
  chapterNumber: id,
  uploadDate: '0',
  fetchedAt,
  isDownloaded: true,
  ...overrides,
});

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('SuwayomiAPI chapter releases', () => {
  it('reads both lists and sends the fetched-at bounds in seconds', async () => {
    const server = await start();
    server.onOperation(
      'ChapterReleases',
      page(
        {
          nodes: [
            dated(10, String(FROM)),
            dated(11, String(BEFORE - 1), { chapterNumber: 2.5 }),
          ],
        },
        {
          nodes: [
            undated(20, String(Math.ceil(FROM / 1_000))),
            undated(21, '1700000000', { uploadDate: null }),
          ],
        }
      )
    );

    const read = await connect(server).getChapterReleases(
      ['1', '2'],
      WINDOW,
      5
    );

    assert.deepEqual(read, {
      mangas: [{ id: '1', sourceId: '0', url: '/title-1' }],
      chapters: [
        {
          id: '10',
          mangaId: '1',
          chapterNumber: 10,
          isDownloaded: false,
          releasedAt: FROM,
        },
        {
          id: '11',
          mangaId: '1',
          chapterNumber: 2.5,
          isDownloaded: false,
          releasedAt: BEFORE - 1,
        },
        {
          id: '20',
          mangaId: '1',
          chapterNumber: 20,
          isDownloaded: true,
          releasedAt: Math.ceil(FROM / 1_000) * 1_000,
        },
      ],
      pages: 1,
      complete: true,
    });
    // Chapter 21 was stored half a second before the window opened; the
    // server's whole-second filter lets it through, the client does not.
    assert.deepEqual(server.operations('ChapterReleases')[0].variables, {
      ids: [1, 2],
      uploadedFrom: String(FROM),
      uploadedBefore: String(BEFORE),
      fetchedFrom: '1700000000',
      fetchedBefore: '1700086401',
      uploadedAfter: null,
      undatedAfter: null,
    });
  });

  it('drops rows outside the window or without the date their list uses', async () => {
    const server = await start();
    server.onOperation(
      'ChapterReleases',
      page(
        {
          nodes: [
            dated(1, String(FROM - 1)),
            dated(2, String(BEFORE)),
            dated(3, '0'),
            dated(4, null),
            dated(5, '-5'),
            dated(6, String(FROM + 1), { chapterNumber: null }),
          ],
        },
        {
          nodes: [
            undated(7, String(Math.ceil(FROM / 1_000)), {
              uploadDate: String(FROM),
            }),
            undated(8, '0'),
            undated(9, String(Math.ceil(BEFORE / 1_000))),
            undated(10, '1700000060', { uploadDate: '-1' }),
          ],
        }
      )
    );

    const read = await connect(server).getChapterReleases(['1'], WINDOW, 5);

    assert.deepEqual(
      read.chapters.map(({ id, chapterNumber, releasedAt }) => ({
        id,
        chapterNumber,
        releasedAt,
      })),
      [
        { id: '6', chapterNumber: -1, releasedAt: FROM + 1 },
        { id: '10', chapterNumber: 10, releasedAt: 1_700_000_060_000 },
      ]
    );
  });

  it('pages each list on its own, reads the manga once and ignores a finished list', async () => {
    const server = await start();
    server.onOperation(
      'ChapterReleases',
      page(
        {
          nodes: [dated(10, String(FROM))],
          hasNextPage: true,
          endCursor: '10',
        },
        {
          nodes: [undated(20, '1700000100')],
          hasNextPage: false,
          endCursor: '20',
        }
      ),
      page(
        {
          nodes: [dated(12, String(FROM))],
          hasNextPage: false,
          endCursor: '12',
        },
        // Only a list that already ended is sent again with its last cursor.
        { nodes: [undated(21, '1700000100')], endCursor: '21' },
        [{ id: 9, sourceId: '0', url: '/other' }]
      )
    );

    const read = await connect(server).getChapterReleases(['1'], WINDOW, 5);

    assert.deepEqual(
      read.chapters.map(({ id }) => id),
      ['10', '20', '12']
    );
    assert.deepEqual(read.mangas, [
      { id: '1', sourceId: '0', url: '/title-1' },
    ]);
    assert.deepEqual([read.pages, read.complete], [2, true]);
    assert.deepEqual(
      server
        .operations('ChapterReleases')
        .map(({ variables }) => [
          variables.uploadedAfter,
          variables.undatedAfter,
        ]),
      [
        [null, null],
        ['10', '20'],
      ]
    );
  });

  it('accepts the same cursor in both lists', async () => {
    const server = await start();
    server.onOperation(
      'ChapterReleases',
      page(
        { hasNextPage: true, endCursor: '5' },
        { hasNextPage: true, endCursor: '5' }
      ),
      page({ endCursor: '6' }, { endCursor: '7' })
    );
    const read = await connect(server).getChapterReleases(['1'], WINDOW, 5);
    assert.deepEqual([read.pages, read.complete], [2, true]);
  });

  it('stops after the page budget and reports an incomplete read', async () => {
    const server = await start();
    let next = 0;
    server.onOperation('ChapterReleases', () => {
      next += 1;
      return page(
        {
          nodes: [dated(next, String(FROM))],
          hasNextPage: true,
          endCursor: String(next),
        },
        {}
      );
    });

    const read = await connect(server).getChapterReleases(['1'], WINDOW, 3);

    assert.deepEqual([read.pages, read.complete], [3, false]);
    assert.deepEqual(
      read.chapters.map(({ id }) => id),
      ['1', '2', '3']
    );
    assert.equal(server.operations('ChapterReleases').length, 3);
  });

  it('fails on a page list it cannot follow', async () => {
    const cases: [string, FakeReply[]][] = [
      ['text hasNextPage', [page({ hasNextPage: 'false' })]],
      [
        'missing page info',
        [
          graphqlData({
            mangas: { nodes: [] },
            uploaded: { nodes: [] },
            undated: list({}),
          }),
        ],
      ],
      ['missing cursor', [page({}, { hasNextPage: true })]],
      ['empty cursor', [page({ hasNextPage: true, endCursor: '' })]],
      [
        'oversized cursor',
        [page({ hasNextPage: true, endCursor: 'c'.repeat(257) })],
      ],
      [
        'repeated cursor',
        [
          page({ hasNextPage: true, endCursor: '1' }),
          page({ hasNextPage: true, endCursor: '1' }),
        ],
      ],
      [
        'missing list',
        [
          graphqlData({
            mangas: { nodes: [] },
            uploaded: list({}),
            undated: null,
          }),
        ],
      ],
      [
        'missing manga list',
        [graphqlData({ mangas: null, uploaded: list({}), undated: list({}) })],
      ],
    ];
    for (const [label, replies] of cases) {
      const server = await start();
      server.onOperation('ChapterReleases', ...replies);
      await assert.rejects(
        connect(server).getChapterReleases(['1'], WINDOW, 5),
        { code: 'BAD_RESPONSE' },
        label
      );
    }
  });

  it('fails on a row or manga it cannot read', async () => {
    const cases: [string, FakeReply][] = [
      [
        'text download state',
        page({ nodes: [dated(1, String(FROM), { isDownloaded: 'true' })] }),
      ],
      [
        'missing chapter ID',
        page({ nodes: [dated(1, String(FROM), { id: null })] }),
      ],
      [
        'text manga ID',
        page({ nodes: [dated(1, String(FROM), { mangaId: 'one' })] }),
      ],
      ['missing source', page({}, {}, [{ id: 1, url: '/title-1' }])],
      ['negative manga', page({}, {}, [{ id: -1, sourceId: '0' }])],
    ];
    for (const [label, reply] of cases) {
      const server = await start();
      server.onOperation('ChapterReleases', reply);
      await assert.rejects(
        connect(server).getChapterReleases(['1'], WINDOW, 5),
        { code: 'BAD_RESPONSE' },
        label
      );
    }
  });

  it('leaves out a manga URL it cannot match on', async () => {
    const server = await start();
    server.onOperation(
      'ChapterReleases',
      page({}, {}, [
        { id: 1, sourceId: '0', url: '' },
        { id: 2, sourceId: '0', url: `/${'u'.repeat(2_048)}` },
        { id: 3, sourceId: '0', url: '/line\nbreak' },
        { id: 4, sourceId: '0', url: 4 },
      ])
    );
    const read = await connect(server).getChapterReleases(
      ['1', '2', '3', '4'],
      WINDOW,
      5
    );
    assert.deepEqual(
      read.mangas,
      ['1', '2', '3', '4'].map((id) => ({ id, sourceId: '0', url: undefined }))
    );
  });

  it('refuses invalid IDs, windows and page budgets before sending', async () => {
    const server = await start();
    const api = connect(server);
    const calls: [string, () => Promise<unknown>][] = [
      ['no IDs', () => api.getChapterReleases([], WINDOW, 5)],
      [
        '101 IDs',
        () =>
          api.getChapterReleases(
            Array.from({ length: 101 }, (_, i) => `${i + 1}`),
            WINDOW,
            5
          ),
      ],
      ['text ID', () => api.getChapterReleases(['one'], WINDOW, 5)],
      [
        'invalid date',
        () =>
          api.getChapterReleases(
            ['1'],
            { from: new Date(Number.NaN), before: WINDOW.before },
            5
          ),
      ],
      [
        'no dates',
        () =>
          api.getChapterReleases(
            ['1'],
            { from: FROM, before: BEFORE } as unknown as typeof WINDOW,
            5
          ),
      ],
      [
        'before 1970',
        () =>
          api.getChapterReleases(
            ['1'],
            { from: new Date(-1), before: WINDOW.before },
            5
          ),
      ],
      [
        'empty window',
        () =>
          api.getChapterReleases(
            ['1'],
            { from: WINDOW.from, before: WINDOW.from },
            5
          ),
      ],
      ['no pages', () => api.getChapterReleases(['1'], WINDOW, 0)],
      ['fractional pages', () => api.getChapterReleases(['1'], WINDOW, 1.5)],
    ];
    for (const [label, call] of calls) {
      await assert.rejects(call(), { code: 'INVALID_ARGUMENT' }, label);
    }
    assert.equal(server.requests.length, 0);
  });
});

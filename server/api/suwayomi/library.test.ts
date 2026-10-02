import SuwayomiAPI from '@server/api/suwayomi';
import type { SuwayomiAPIOptions } from '@server/api/suwayomi/types';
import {
  graphqlData,
  graphqlErrors,
  missingLookup,
  startFakeSuwayomi,
  syntheticFailure,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const servers: FakeSuwayomi[] = [];
const MAX_LONG = '9223372036854775807';

const start = async () => {
  const server = await startFakeSuwayomi({ mode: 'NONE' });
  servers.push(server);
  return server;
};

const connect = (
  server: FakeSuwayomi,
  overrides: Partial<SuwayomiAPIOptions> = {}
) =>
  new SuwayomiAPI({
    url: server.url,
    auth: { mode: 'NONE' },
    readback: { attempts: 2, delayMs: 0 },
    ...overrides,
  });

const manga = (id: number, patch: Record<string, unknown> = {}) => ({
  id,
  sourceId: MAX_LONG,
  url: `/title/fake-${id}`,
  title: `Fake Title ${id}`,
  status: 'ONGOING',
  inLibrary: false,
  initialized: true,
  chapters: { totalCount: 2 },
  meta: [],
  ...patch,
});

const chapter = (id: number, patch: Record<string, unknown> = {}) => ({
  id,
  mangaId: 7,
  url: `/chapter/${id}`,
  name: `Chapter ${id}`,
  chapterNumber: id,
  sourceOrder: id,
  isDownloaded: false,
  ...patch,
});

const queueStatus = (state: string, chapterIds: number[] = []) => ({
  downloadStatus: {
    state,
    queue: chapterIds.map((id) => ({
      state: 'QUEUED',
      progress: 0,
      tries: 0,
      chapter: { id, mangaId: 7 },
    })),
  },
});

const STATUS = { downloadStatus: { state: 'STARTED' } };

/** One ReverseIndex page holding an entry per request ID. */
const indexPage = (
  endCursor: unknown,
  hasNextPage = true,
  requestIds: number[] = []
) =>
  graphqlData({
    metas: {
      pageInfo: { hasNextPage, endCursor },
      nodes: requestIds.map((id) => ({
        key: `seerrng.request.${id}`,
        value: String(id),
      })),
    },
  });

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('SuwayomiAPI argument validation', () => {
  it('rejects malformed IDs and values before sending anything', async () => {
    const server = await start();
    const api = connect(server);
    const calls: [string, () => Promise<unknown>][] = [
      ['negative ID', () => api.getMangaDetails('-1')],
      ['fractional ID', () => api.getMangaDetails('1.5')],
      ['Int overflow', () => api.getMangaDetails('2147483648')],
      ['number ID', () => api.getMangaDetails(7 as never)],
      ['Long overflow', () => api.searchSource('9223372036854775808', 'x')],
      ['empty query', () => api.searchSource('1', '  ')],
      ['page 0', () => api.searchSource('1', 'x', 0)],
      ['category 0', () => api.addMangaToCategory('7', '0')],
      ['default category', () => api.findCategory('Default')],
      ['padded category', () => api.createCategory(' Manga')],
      ['control category', () => api.createCategory('Manga\n')],
      ['long category', () => api.createCategory('x'.repeat(65))],
      ['long meta', () => api.setRequestStamp('7', 'x'.repeat(4_097))],
      ['request 0', () => api.setRequestIndex('0', '{}')],
      ['request 01', () => api.deleteRequestIndex('01')],
      ['request overflow', () => api.setRequestIndex('12345678901', '{}')],
      ['no chapters', () => api.enqueueChapters([])],
      [
        'too many chapters',
        () =>
          api.getChapterStates(Array.from({ length: 101 }, (_, i) => `${i}`)),
      ],
      ['in-library flag', () => api.setInLibrary('7', 'yes' as never)],
    ];
    for (const [label, call] of calls) {
      await assert.rejects(call(), { code: 'INVALID_ARGUMENT' }, label);
    }
    assert.equal(server.requests.length, 0);
  });

  it('keeps 64-bit IDs as strings end to end', async () => {
    const server = await start();
    server.onOperation(
      'SearchSource',
      graphqlData({
        fetchSourceManga: { hasNextPage: true, mangas: [manga(7)] },
      })
    );
    const page = await connect(server).searchSource(MAX_LONG, 'fake', 2);
    assert.deepEqual(server.operations('SearchSource')[0].variables, {
      source: MAX_LONG,
      query: 'fake',
      page: 2,
    });
    assert.equal(page.hasNextPage, true);
    assert.equal(page.mangas[0].id, '7');
    assert.equal(page.mangas[0].sourceId, MAX_LONG);
  });
});

describe('SuwayomiAPI catalog and library', () => {
  it('prefers a library entry, then the lowest ID, for a natural key', async () => {
    const server = await start();
    server.onOperation(
      'ByNaturalKey',
      graphqlData({
        mangas: { nodes: [manga(9), manga(8, { inLibrary: true }), manga(3)] },
      }),
      graphqlData({ mangas: { nodes: [manga(9), manga(3)] } }),
      graphqlData({ mangas: { nodes: [] } })
    );
    const api = connect(server);
    assert.equal(
      (await api.findMangaByNaturalKey(MAX_LONG, '/title/fake'))?.id,
      '8'
    );
    assert.equal(
      (await api.findMangaByNaturalKey(MAX_LONG, '/title/fake'))?.id,
      '3'
    );
    assert.equal(
      await api.findMangaByNaturalKey(MAX_LONG, '/title/fake'),
      undefined
    );
  });

  it('reads manga details and reports a missing manga as NOT_FOUND', async () => {
    const server = await start();
    server.onOperation(
      'MangaDetails',
      graphqlData({ manga: manga(7) }),
      graphqlErrors([syntheticFailure('Manga not found')]),
      missingLookup('manga')
    );
    const api = connect(server);
    assert.equal((await api.getMangaDetails('7')).chapterCount, 2);
    await assert.rejects(api.getMangaDetails('8'), { code: 'NOT_FOUND' });
    await assert.rejects(api.getMangaDetails('9'), { code: 'NOT_FOUND' });
  });

  it('returns fresh fetch results', async () => {
    const server = await start();
    server.onOperation(
      'FetchMangaAndChapters',
      graphqlData({
        fetchMangaAndChapters: { manga: manga(7), chapters: [chapter(1)] },
      })
    );
    const result = await connect(server).fetchMangaAndChapters('7', {
      fetchManga: false,
    });
    assert.equal(result.fresh, true);
    assert.equal(result.chapters?.[0].id, '1');
    assert.deepEqual(server.operations('FetchMangaAndChapters')[0].variables, {
      id: 7,
      fetchManga: false,
    });
  });

  it('keeps the cached data Suwayomi returns with a failed fetch', async () => {
    const server = await start();
    server.onOperation(
      'FetchMangaAndChapters',
      graphqlErrors([syntheticFailure()], {
        fetchMangaAndChapters: { manga: manga(7), chapters: [chapter(1)] },
      }),
      graphqlErrors([syntheticFailure()], {
        fetchMangaAndChapters: { manga: null, chapters: null },
      }),
      graphqlErrors([syntheticFailure()]),
      graphqlErrors(['Unauthorized'], {
        fetchMangaAndChapters: { manga: manga(7), chapters: [] },
      }),
      graphqlErrors(['Unauthorized'], { fetchMangaAndChapters: null })
    );
    const api = connect(server);
    const partial = await api.fetchMangaAndChapters('7');
    assert.equal(partial.fresh, false);
    assert.equal(partial.issue, 'UPSTREAM_ERROR');
    assert.equal(partial.manga?.id, '7');
    assert.equal(partial.chapters?.length, 1);
    assert.deepEqual(await api.fetchMangaAndChapters('7'), {
      fresh: false,
      issue: 'UPSTREAM_ERROR',
      manga: undefined,
      chapters: undefined,
    });
    await assert.rejects(api.fetchMangaAndChapters('7'), {
      code: 'UPSTREAM_ERROR',
      errorCount: 1,
    });
    // Once the root field resolved, auth-like text came from the source.
    const sourceText = await api.fetchMangaAndChapters('7');
    assert.equal(sourceText.issue, 'UPSTREAM_ERROR');
    assert.equal(sourceText.manga?.id, '7');
    await assert.rejects(api.fetchMangaAndChapters('7'), {
      code: 'AUTH_REQUIRED',
    });
  });

  it('reads the stored manga back when a fetch times out', async () => {
    const server = await start();
    server.onOperation('FetchMangaAndChapters', { hang: true });
    server.onOperation(
      'MangaDetails',
      graphqlData({
        manga: manga(7, { chaptersLastFetchedAt: 1_700_000_000 }),
      }),
      graphqlErrors([syntheticFailure()])
    );
    const api = connect(server, { timeouts: { source: 100 } });
    const result = await api.fetchMangaAndChapters('7');
    assert.equal(result.fresh, false);
    assert.equal(result.issue, 'TIMEOUT');
    assert.equal(result.manga?.chaptersLastFetchedAt, '1700000000');
    assert.equal(result.chapters, undefined);
    await assert.rejects(api.fetchMangaAndChapters('7'), { code: 'TIMEOUT' });
  });

  it('reports an abort during the timeout read-back as ABORTED', async () => {
    const server = await start();
    const controller = new AbortController();
    server.onOperation('FetchMangaAndChapters', { hang: true });
    server.onOperation('MangaDetails', () => {
      controller.abort();
      return { hang: true };
    });
    const api = connect(server, { timeouts: { query: 5_000, source: 100 } });
    await assert.rejects(
      api.fetchMangaAndChapters('7', { signal: controller.signal }),
      { code: 'ABORTED' }
    );
    assert.equal(server.operations('MangaDetails').length, 1);
  });

  it('gives source calls the longer source timeout', async () => {
    const server = await start();
    server.onOperation('SearchSource', {
      ...graphqlData({ fetchSourceManga: { hasNextPage: false, mangas: [] } }),
      delayMs: 300,
    });
    const api = connect(server, { timeouts: { query: 100, source: 5_000 } });
    assert.deepEqual(await api.searchSource('1', 'fake'), {
      hasNextPage: false,
      mangas: [],
    });
  });

  it('sets library membership and categories', async () => {
    const server = await start();
    server.onOperation(
      'SetInLibrary',
      graphqlData({ updateManga: { manga: { id: 7, inLibrary: true } } })
    );
    server.onOperation(
      'AddMangaToCategory',
      graphqlData({ updateMangaCategories: { manga: { id: 7 } } })
    );
    server.onOperation(
      'RemoveMangaFromCategory',
      graphqlData({ updateMangaCategories: { manga: { id: 7 } } })
    );
    const api = connect(server);
    await api.setInLibrary('7', true);
    await api.addMangaToCategory('7', '2');
    await api.removeMangaFromCategory('7', '2');
    assert.deepEqual(server.operations('SetInLibrary')[0].variables, {
      id: 7,
      inLibrary: true,
    });
    for (const name of ['AddMangaToCategory', 'RemoveMangaFromCategory']) {
      assert.deepEqual(server.operations(name)[0].variables, {
        id: 7,
        categoryId: 2,
      });
    }
  });

  it('finds a category by its exact name or creates it', async () => {
    const server = await start();
    const category = { id: 2, name: 'Manga', includeInUpdate: 'UNSET' };
    server.onOperation(
      'FindCategory',
      graphqlData({
        categories: { nodes: [{ id: 5, name: 'manga' }, category] },
      }),
      graphqlData({ categories: { nodes: [] } }),
      graphqlData({ categories: { nodes: [] } }),
      graphqlData({ categories: { nodes: [category] } })
    );
    server.onOperation(
      'CreateCategory',
      graphqlData({ createCategory: { category } }),
      graphqlErrors([syntheticFailure('duplicate')])
    );
    const api = connect(server);
    assert.equal((await api.findOrCreateCategory('Manga')).id, '2');
    assert.equal(server.operations('CreateCategory').length, 0);
    assert.equal((await api.findOrCreateCategory('Manga')).id, '2');
    assert.equal(server.operations('CreateCategory').length, 1);
    assert.equal((await api.findOrCreateCategory('Manga')).id, '2');
    assert.equal(server.operations('CreateCategory').length, 2);
  });
});

describe('SuwayomiAPI request meta', () => {
  it('writes and deletes the manga request stamp', async () => {
    const server = await start();
    server.onOperation(
      'SetRequestStamp',
      graphqlData({ setMangaMeta: { meta: { key: 'seerrng.request' } } })
    );
    server.onOperation(
      'DeleteRequestStamp',
      graphqlData({ deleteMangaMeta: { meta: null } }),
      graphqlErrors([syntheticFailure('Meta not found')])
    );
    const api = connect(server);
    await api.setRequestStamp('7', '{"requestId":"1"}');
    await api.deleteRequestStamp('7');
    await api.deleteRequestStamp('7');
    assert.deepEqual(server.operations('SetRequestStamp')[0].variables, {
      mangaId: 7,
      value: '{"requestId":"1"}',
    });
  });

  it('maintains the global request index', async () => {
    const server = await start();
    server.onOperation(
      'SetRequestIndex',
      graphqlData({ setGlobalMeta: { meta: { key: 'seerrng.request.42' } } })
    );
    server.onOperation(
      'DeleteRequestIndex',
      graphqlErrors([syntheticFailure('NoSuchElementException')])
    );
    server.onOperation(
      'ReverseIndex',
      graphqlData({
        metas: {
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          nodes: [
            { key: 'seerrng.request.42', value: '7' },
            { key: 'seerrng.request.042', value: '8' },
            { key: 'seerrng.request.43', value: 'x'.repeat(4_097) },
          ],
        },
      }),
      graphqlData({
        metas: {
          pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
          nodes: [{ key: 'seerrng.request.44', value: '9' }],
        },
      })
    );
    const api = connect(server);
    await api.setRequestIndex('42', '7');
    await api.deleteRequestIndex('42');
    assert.deepEqual(await api.listRequestIndex(), [
      { requestId: '42', value: '7' },
      { requestId: '44', value: '9' },
    ]);
    assert.deepEqual(
      server.operations('ReverseIndex').map((request) => request.variables),
      [{ after: null }, { after: 'cursor-1' }]
    );
    assert.deepEqual(server.operations('SetRequestIndex')[0].variables, {
      key: 'seerrng.request.42',
      value: '7',
    });
    assert.deepEqual(server.operations('DeleteRequestIndex')[0].variables, {
      key: 'seerrng.request.42',
    });
  });

  it('refuses a next page without a usable cursor', async () => {
    const server = await start();
    const missing = [null, undefined, '', 42];
    server.onOperation(
      'ReverseIndex',
      ...missing.map((cursor) => indexPage(cursor, true, [1]))
    );
    const api = connect(server);
    for (const cursor of missing) {
      await assert.rejects(
        api.listRequestIndex(),
        { code: 'BAD_RESPONSE' },
        String(cursor)
      );
    }
    assert.equal(server.operations('ReverseIndex').length, missing.length);
  });

  it('refuses a cursor longer than 256 characters', async () => {
    const server = await start();
    server.onOperation(
      'ReverseIndex',
      indexPage('c'.repeat(256), true, [1]),
      indexPage(null, false, [2]),
      indexPage('c'.repeat(257), true, [3])
    );
    const api = connect(server);
    assert.deepEqual(await api.listRequestIndex(), [
      { requestId: '1', value: '1' },
      { requestId: '2', value: '2' },
    ]);
    await assert.rejects(api.listRequestIndex(), { code: 'BAD_RESPONSE' });
  });

  it('refuses a cursor it has already followed', async () => {
    const server = await start();
    server.onOperation(
      'ReverseIndex',
      indexPage('cursor-1', true, [1]),
      indexPage('cursor-2', true, [2]),
      indexPage('cursor-1', true, [3])
    );
    await assert.rejects(connect(server).listRequestIndex(), {
      code: 'BAD_RESPONSE',
    });
    assert.deepEqual(
      server.operations('ReverseIndex').map(({ variables }) => variables.after),
      [null, 'cursor-1', 'cursor-2']
    );
  });

  it('reads 100 pages and refuses an index that needs more', async () => {
    const server = await start();
    let pages = 100;
    let page = 0;
    server.onOperation('ReverseIndex', ({ variables }) => {
      page = variables.after === null ? 1 : page + 1;
      return indexPage(`cursor-${page}`, page < pages, [page]);
    });
    const api = connect(server);
    assert.equal((await api.listRequestIndex()).length, 100);
    pages = 101;
    await assert.rejects(api.listRequestIndex(), { code: 'BAD_RESPONSE' });
    assert.equal(server.operations('ReverseIndex').length, 200);
  });

  it('reads and writes the instance marker', async () => {
    const server = await start();
    server.onOperation(
      'InstanceMarker',
      graphqlData({ meta: { key: 'seerrng.instance', value: 'instance-1' } }),
      graphqlData({ meta: null }),
      graphqlErrors([syntheticFailure('not found')]),
      missingLookup('meta'),
      graphqlErrors([syntheticFailure()])
    );
    server.onOperation(
      'SetInstanceMarker',
      graphqlData({ setGlobalMeta: { meta: { key: 'seerrng.instance' } } })
    );
    const api = connect(server);
    assert.equal(await api.getInstanceMarker(), 'instance-1');
    assert.equal(await api.getInstanceMarker(), undefined);
    assert.equal(await api.getInstanceMarker(), undefined);
    assert.equal(await api.getInstanceMarker(), undefined);
    await assert.rejects(api.getInstanceMarker(), { code: 'UPSTREAM_ERROR' });
    await api.setInstanceMarker('instance-2');
    assert.deepEqual(server.operations('SetInstanceMarker')[0].variables, {
      value: 'instance-2',
    });
  });
});

describe('SuwayomiAPI chapters and queue', () => {
  it('lists chapters and their download state', async () => {
    const server = await start();
    const chapters = graphqlData({
      chapters: { nodes: [chapter(2), chapter(1)] },
    });
    server.onOperation('ChaptersToDownload', chapters);
    server.onOperation('DownloadedChapters', chapters);
    server.onOperation(
      'ChapterStates',
      graphqlData({
        chapters: { nodes: [{ id: 1, mangaId: 7, isDownloaded: true }] },
      })
    );
    const api = connect(server);
    assert.deepEqual(
      (await api.getChaptersToDownload('7')).map((item) => item.id),
      ['2', '1']
    );
    assert.equal((await api.getDownloadedChapters('7')).length, 2);
    assert.deepEqual(await api.getChapterStates(['1', '1', '2']), [
      { id: '1', mangaId: '7', isDownloaded: true },
    ]);
    assert.deepEqual(server.operations('ChapterStates')[0].variables, {
      ids: [1, 2],
    });
  });

  it('reads the queue and library availability in one call', async () => {
    const server = await start();
    server.onOperation(
      'Availability',
      graphqlData({
        mangas: {
          nodes: [
            {
              id: 7,
              inLibrary: true,
              downloadCount: 1,
              chapters: { totalCount: 2 },
            },
          ],
        },
        ...queueStatus('STARTED', [1]),
      })
    );
    server.onOperation('Queue', graphqlData(queueStatus('STOPPED')));
    const api = connect(server);
    const snapshot = await api.getAvailability(['7']);
    assert.equal(snapshot.mangas[0].downloadCount, 1);
    assert.equal(snapshot.queue.items[0].chapterId, '1');
    assert.deepEqual(await api.getQueue(), { state: 'STOPPED', items: [] });
  });

  it('confirms a queue mutation from its response', async () => {
    const server = await start();
    server.onOperation(
      'EnqueueChapters',
      graphqlData({ enqueueChapterDownloads: STATUS })
    );
    assert.deepEqual(await connect(server).enqueueChapters(['1', '2']), {
      confirmedBy: 'response',
    });
    assert.deepEqual(server.operations('EnqueueChapters')[0].variables, {
      ids: [1, 2],
    });
    assert.equal(server.operations('Queue').length, 0);
  });

  it('waits for a slow queue mutation within the queue timeout', async () => {
    const server = await start();
    server.onOperation('DequeueChapters', {
      ...graphqlData({ dequeueChapterDownloads: STATUS }),
      delayMs: 300,
    });
    const api = connect(server, {
      timeouts: { query: 100, mutation: 100, queue: 5_000 },
    });
    assert.deepEqual(await api.dequeueChapters(['1']), {
      confirmedBy: 'response',
    });
  });

  it('confirms a timed-out enqueue by reading the queue back', async () => {
    const server = await start();
    server.onOperation('EnqueueChapters', { hang: true });
    server.onOperation(
      'Queue',
      graphqlData(queueStatus('STARTED')),
      graphqlData(queueStatus('STARTED', [1]))
    );
    server.onOperation(
      'ChapterStates',
      graphqlData({
        chapters: {
          nodes: [
            { id: 1, mangaId: 7, isDownloaded: false },
            { id: 2, mangaId: 7, isDownloaded: true },
          ],
        },
      })
    );
    const api = connect(server, { timeouts: { queue: 100 } });
    assert.deepEqual(await api.enqueueChapters(['1', '2']), {
      confirmedBy: 'readback',
    });
    assert.equal(server.operations('Queue').length, 2);
  });

  it('fails a timed-out mutation that the readback cannot confirm', async () => {
    const server = await start();
    server.onOperation('StartDownloader', { hang: true });
    server.onOperation('Queue', graphqlData(queueStatus('STOPPED')));
    const api = connect(server, {
      timeouts: { queue: 100 },
      readback: { attempts: 3, delayMs: 0 },
    });
    await assert.rejects(api.startDownloader(), { code: 'TIMEOUT' });
    assert.equal(server.operations('StartDownloader').length, 1);
    assert.equal(server.operations('Queue').length, 3);
  });

  it('reads back after a server-side error too', async () => {
    const server = await start();
    server.onOperation('DequeueChapters', graphqlErrors([syntheticFailure()]));
    server.onOperation('Queue', graphqlData(queueStatus('STARTED', [5])));
    assert.deepEqual(await connect(server).dequeueChapters(['1']), {
      confirmedBy: 'readback',
    });
  });

  it('reads back after the connection drops mid-response', async () => {
    const server = await start();
    server.onOperation('DequeueChapters', {
      chunks: ['{"data":', '{"dequeueChapterDownloads":null}}'],
      chunkDelayMs: 50,
      dropAfterChunks: 1,
    });
    server.onOperation('Queue', graphqlData(queueStatus('STARTED', [5])));
    assert.deepEqual(await connect(server).dequeueChapters(['1']), {
      confirmedBy: 'readback',
    });
    assert.equal(server.operations('DequeueChapters').length, 1);
  });

  it('does not read back after an authentication failure', async () => {
    const server = await start();
    server.onOperation('StartDownloader', graphqlErrors(['Unauthorized']));
    await assert.rejects(connect(server).startDownloader(), {
      code: 'AUTH_REQUIRED',
    });
    assert.equal(server.operations('Queue').length, 0);
  });

  it('stops reading back when the caller aborts', async () => {
    const server = await start();
    server.onOperation('StartDownloader', { hang: true });
    server.onOperation('Queue', graphqlData(queueStatus('STOPPED')));
    const controller = new AbortController();
    const api = connect(server, {
      timeouts: { queue: 100 },
      readback: { attempts: 50, delayMs: 20 },
    });
    const pending = api.startDownloader({ signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(pending, { code: 'ABORTED' });
    assert.ok(server.operations('Queue').length < 50);
  });
});

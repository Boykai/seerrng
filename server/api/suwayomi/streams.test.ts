import SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import type {
  SuwayomiAPIOptions,
  SuwayomiAuthConfig,
} from '@server/api/suwayomi/types';
import {
  startFakeSuwayomi,
  type FakeAuthMode,
  type FakeReply,
  type FakeSuwayomi,
} from '@server/test/fakeSuwayomi';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { globalAgent } from 'node:http';
import type { Readable } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const USERNAME = 'fake-user';
const PASSWORD = randomUUID();
const ARCHIVE = '/api/v1/chapter/11/download';
const THUMBNAIL = '/api/v1/manga/7/thumbnail';
const ZIP = { 'Content-Type': 'application/zip' };
const servers: FakeSuwayomi[] = [];

const start = async (mode: FakeAuthMode = 'UI_LOGIN') => {
  const server = await startFakeSuwayomi({
    mode,
    username: USERNAME,
    password: PASSWORD,
  });
  servers.push(server);
  return server;
};

const connect = (
  server: FakeSuwayomi,
  overrides: Partial<SuwayomiAPIOptions> = {}
) =>
  new SuwayomiAPI({
    url: server.url,
    auth: { mode: 'UI_LOGIN', username: USERNAME, password: PASSWORD },
    ...overrides,
  });

const routeRequests = (server: FakeSuwayomi, path: string) =>
  server.requests.filter((request) => request.url === path);

const readAll = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

/** Counts the default agent's sockets for one origin in `pool`. */
const pooled = (pool: NodeJS.ReadOnlyDict<unknown[]>, server: FakeSuwayomi) =>
  Object.entries(pool)
    .filter(([name]) => name.startsWith(`${new URL(server.url).host}:`))
    .reduce((total, [, sockets]) => total + (sockets?.length ?? 0), 0);

const archive = (body: Buffer, headers: Record<string, string> = {}) => ({
  status: 200,
  headers: { ...ZIP, 'Content-Length': String(body.length), ...headers },
  body,
});

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('SuwayomiAPI chapter archive HEAD', () => {
  it('reports the archive size with the access token', async () => {
    const server = await start();
    server.onRoute('HEAD', ARCHIVE, archive(Buffer.alloc(1_234)));
    assert.deepEqual(await connect(server).headChapterArchive('11'), {
      contentLength: 1_234,
      contentType: 'application/zip',
    });
    const [request] = routeRequests(server, ARCHIVE);
    assert.equal(request.method, 'HEAD');
    assert.match(request.headers.authorization ?? '', /^Bearer /);
  });

  it('treats a zero length as not downloaded', async () => {
    const server = await start();
    server.onRoute('HEAD', ARCHIVE, {
      status: 200,
      headers: { ...ZIP, 'Content-Length': '0' },
    });
    await assert.rejects(connect(server).headChapterArchive('11'), {
      code: 'NOT_DOWNLOADED',
    });
  });

  it('rejects an archive above the configured limit', async () => {
    const server = await start();
    server.onRoute('HEAD', ARCHIVE, archive(Buffer.alloc(2_000)));
    const api = connect(server, { limits: { chapterArchiveBytes: 1_000 } });
    await assert.rejects(api.headChapterArchive('11'), {
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('refuses a cross-origin redirect', async () => {
    const other = await start('NONE');
    const server = await start();
    server.onRoute('HEAD', ARCHIVE, {
      status: 307,
      headers: { Location: `${other.url}api/v1/chapter/11/download` },
    });
    await assert.rejects(connect(server).headChapterArchive('11'), {
      code: 'REQUEST_REFUSED',
    });
    assert.equal(other.requests.length, 0);
  });
});

describe('SuwayomiAPI chapter archive download', () => {
  it('streams the archive', async () => {
    const server = await start();
    const body = Buffer.from('PK\u0003\u0004 fake archive');
    server.onRoute('GET', ARCHIVE, archive(body));
    const download = await connect(server).streamChapterArchive('11');
    assert.equal(download.contentLength, body.length);
    assert.equal(download.contentType, 'application/zip');
    assert.deepEqual(await readAll(download.stream), body);
  });

  it('accepts a chunked archive without a length', async () => {
    const server = await start();
    server.onRoute('GET', ARCHIVE, {
      headers: ZIP,
      chunks: ['PK', 'fake', 'archive'],
      chunkDelayMs: 5,
    });
    const download = await connect(server).streamChapterArchive('11');
    assert.equal(download.contentLength, undefined);
    assert.equal((await readAll(download.stream)).toString(), 'PKfakearchive');
  });

  it('maps route failures to codes', async () => {
    const cases: [FakeReply, string][] = [
      [{ status: 400, body: 'Chapter not downloaded' }, 'NOT_DOWNLOADED'],
      [
        { status: 200, headers: { ...ZIP, 'Content-Length': '0' } },
        'NOT_DOWNLOADED',
      ],
      [{ status: 404 }, 'NOT_FOUND'],
      [{ status: 403 }, 'AUTH_FAILED'],
      [{ status: 206, headers: ZIP, body: 'partial' }, 'HTTP_ERROR'],
      [{ status: 500, body: 'failure' }, 'HTTP_ERROR'],
      [archive(Buffer.alloc(2_000)), 'RESPONSE_TOO_LARGE'],
    ];
    for (const [reply, code] of cases) {
      const server = await start();
      server.onRoute('GET', ARCHIVE, reply);
      const api = connect(server, { limits: { chapterArchiveBytes: 1_000 } });
      await assert.rejects(api.streamChapterArchive('11'), { code }, code);
    }
  });

  it('fails the stream once a body without a length passes the limit', async () => {
    const server = await start();
    server.onRoute('GET', ARCHIVE, {
      headers: ZIP,
      chunks: Array.from({ length: 20 }, () => Buffer.alloc(100)),
      chunkDelayMs: 5,
    });
    const api = connect(server, { limits: { chapterArchiveBytes: 1_000 } });
    const { stream } = await api.streamChapterArchive('11');
    await assert.rejects(readAll(stream), (error: unknown) => {
      assert.ok(error instanceof SuwayomiError);
      assert.equal(error.code, 'RESPONSE_TOO_LARGE');
      return true;
    });
    assert.equal(await routeRequests(server, ARCHIVE)[0].closed, false);
  });

  it('returns before the body ends and cancels upstream when destroyed', async () => {
    const server = await start();
    server.onRoute('GET', ARCHIVE, {
      headers: { ...ZIP, 'Content-Length': '1000' },
      chunks: [Buffer.alloc(100, 1), Buffer.alloc(900, 2)],
      stallAfterChunks: 1,
    });
    const { stream } = await connect(server).streamChapterArchive('11');
    const [chunk] = (await once(stream, 'data')) as [Buffer];
    assert.equal(chunk.length, 100);
    stream.destroy();
    assert.equal(await routeRequests(server, ARCHIVE)[0].closed, false);
  });

  it('cancels upstream when the caller aborts mid-stream', async () => {
    const server = await start();
    server.onRoute('GET', ARCHIVE, {
      headers: { ...ZIP, 'Content-Length': '1000' },
      chunks: [Buffer.alloc(100), Buffer.alloc(900)],
      stallAfterChunks: 1,
    });
    const controller = new AbortController();
    const { stream } = await connect(server).streamChapterArchive('11', {
      signal: controller.signal,
    });
    await once(stream, 'data');
    const failed = once(stream, 'error');
    controller.abort();
    const [error] = (await failed) as [SuwayomiError];
    assert.equal(error.code, 'ABORTED');
    assert.equal(await routeRequests(server, ARCHIVE)[0].closed, false);
  });

  it('times out when the archive never starts', async () => {
    const server = await start();
    server.onRoute('GET', ARCHIVE, { hang: true });
    const api = connect(server, { timeouts: { bytes: 100 } });
    await assert.rejects(api.streamChapterArchive('11'), { code: 'TIMEOUT' });
    assert.ok(routeRequests(server, ARCHIVE).length <= 2);
  });

  it('renews an expired token and never falls back to Basic', async () => {
    const server = await start();
    server.onRoute('GET', ARCHIVE, archive(Buffer.from('PK')));
    const api = connect(server);
    await readAll((await api.streamChapterArchive('11')).stream);
    server.expireAccessTokens();
    await readAll((await api.streamChapterArchive('11')).stream);
    const sent = routeRequests(server, ARCHIVE).map(
      (request) => request.headers.authorization ?? ''
    );
    assert.equal(sent.length, 3);
    assert.ok(sent.every((value) => value.startsWith('Bearer ')));
    assert.equal(sent[0], sent[1]);
    assert.notEqual(sent[1], sent[2]);
    assert.equal(server.refreshes, 1);
  });

  it('closes the rejected request instead of holding its connection', async () => {
    const server = await start();
    server.onRoute('GET', ARCHIVE, archive(Buffer.from('PK')));
    const api = connect(server);
    await readAll((await api.streamChapterArchive('11')).stream);
    server.expireAccessTokens();
    await readAll((await api.streamChapterArchive('11')).stream);
    assert.equal(routeRequests(server, ARCHIVE).length, 3);
    // An unread 401 body would otherwise keep its socket busy until the
    // server's idle timeout, which is several seconds.
    const deadline = Date.now() + 1_000;
    while (pooled(globalAgent.sockets, server) > 0 && Date.now() < deadline) {
      await sleep(20);
    }
    assert.equal(pooled(globalAgent.sockets, server), 0);
    // The completed requests went back to this pool, so it was the one in use.
    assert.ok(pooled(globalAgent.freeSockets, server) > 0);
  });

  it('stops waiting for a token renewal when the caller aborts', async () => {
    const server = await start();
    server.onRoute('GET', ARCHIVE, archive(Buffer.from('PK')));
    const api = connect(server);
    await readAll((await api.streamChapterArchive('11')).stream);
    server.expireAccessTokens();
    server.onOperation('Refresh', { hang: true });
    const controller = new AbortController();
    const pending = api.streamChapterArchive('11', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await assert.rejects(pending, { code: 'ABORTED' });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(routeRequests(server, ARCHIVE).length, 2);
    assert.equal(server.operations('Refresh').length, 1);
  });

  it('sends the configured credentials in other modes', async () => {
    const modes: [FakeAuthMode, SuwayomiAuthConfig, RegExp | undefined][] = [
      [
        'BASIC_AUTH',
        { mode: 'BASIC_AUTH', username: USERNAME, password: PASSWORD },
        /^Basic /,
      ],
      ['NONE', { mode: 'NONE' }, undefined],
    ];
    for (const [mode, auth, expected] of modes) {
      const server = await start(mode);
      server.onRoute('GET', ARCHIVE, archive(Buffer.from('PK')));
      await readAll(
        (await connect(server, { auth }).streamChapterArchive('11')).stream
      );
      const [request] = routeRequests(server, ARCHIVE);
      if (expected) {
        assert.match(request.headers.authorization ?? '', expected);
      } else {
        assert.equal(request.headers.authorization, undefined);
      }
    }
  });
});

describe('SuwayomiAPI manga thumbnail', () => {
  it('streams images and rejects anything else', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const server = await start();
    server.onRoute(
      'GET',
      THUMBNAIL,
      { headers: { 'Content-Type': 'image/png' }, body: png },
      { headers: { 'Content-Type': 'text/html' }, body: '<html></html>' },
      {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '64' },
        body: Buffer.alloc(64),
      }
    );
    const api = connect(server, { limits: { thumbnailBytes: 32 } });
    const thumbnail = await api.streamMangaThumbnail('7');
    assert.equal(thumbnail.contentType, 'image/png');
    assert.deepEqual(await readAll(thumbnail.stream), png);
    await assert.rejects(api.streamMangaThumbnail('7'), {
      code: 'BAD_RESPONSE',
    });
    await assert.rejects(api.streamMangaThumbnail('7'), {
      code: 'RESPONSE_TOO_LARGE',
    });
  });
});

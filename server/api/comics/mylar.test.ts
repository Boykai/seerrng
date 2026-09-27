import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import MylarAPI, { getMylarIssueFilename } from '@server/api/comics/mylar';

type MockableMylar = {
  get: (
    endpoint: string,
    options?: { params?: Record<string, unknown> },
    ttl?: number
  ) => Promise<unknown>;
};

const mockGet = (
  implementation: (
    endpoint: string,
    options?: { params?: Record<string, unknown> }
  ) => Promise<unknown>
) =>
  mock.method(
    MylarAPI.prototype as unknown as MockableMylar,
    'get',
    implementation
  );

describe('MylarAPI', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('sends apikey and cmd as query params', async () => {
    const getMock = mockGet(async () => ({
      success: true,
      data: { current_version: 'abc123' },
    }));

    const api = new MylarAPI({
      url: 'http://localhost:8090',
      apiKey: 'my-key',
    });
    await api.getVersion();

    assert.strictEqual(getMock.mock.calls[0].arguments[0], '/api');
    assert.deepStrictEqual(getMock.mock.calls[0].arguments[1], {
      params: { apikey: 'my-key', cmd: 'getVersion' },
    });
  });

  it('throws with the Mylar error message when success is false', async () => {
    mockGet(async () => ({
      success: false,
      error: { code: 460, message: 'Unknown command: bogus' },
    }));

    const api = new MylarAPI({ url: 'http://localhost:8090', apiKey: 'key' });
    await assert.rejects(() => api.getVersion(), /Unknown command: bogus/);
  });

  it('parses getIndex, dropping malformed entries', async () => {
    mockGet(async () => ({
      success: true,
      data: [
        { id: '1234', name: 'Batman', totalIssues: '904' },
        { name: 'Missing id' },
      ],
    }));

    const api = new MylarAPI({ url: 'http://localhost:8090', apiKey: 'key' });
    const comics = await api.getIndex();

    assert.strictEqual(comics.length, 1);
    assert.strictEqual(comics[0].name, 'Batman');
    assert.strictEqual(comics[0].totalIssues, 904);
  });

  it('parses getComic into a comic and its issues', async () => {
    mockGet(async () => ({
      success: true,
      data: {
        comic: [{ id: '1234', name: 'Batman' }],
        issues: [
          { id: '1', number: '1' },
          { id: '2', number: '2' },
        ],
      },
    }));

    const api = new MylarAPI({ url: 'http://localhost:8090', apiKey: 'key' });
    const detail = await api.getComic('1234');

    assert.strictEqual(detail.comic?.name, 'Batman');
    assert.strictEqual(detail.issues.length, 2);
  });

  it('parses safe content-disposition filenames without backtracking on malformed headers', () => {
    assert.strictEqual(
      getMylarIssueFilename('attachment; filename="Batman \\"Special\\".cbz"'),
      'Batman "Special".cbz'
    );
    assert.strictEqual(
      getMylarIssueFilename("attachment; filename*=UTF-8''Batman%20%231.cbz"),
      'Batman #1.cbz'
    );
    assert.strictEqual(
      getMylarIssueFilename('attachment; filename="' + '\\\\!'.repeat(128)),
      undefined
    );
  });

  it('addComic sends the ComicVine id as the id param', async () => {
    const getMock = mockGet(async () => ({
      success: true,
      data: 'Successfully queued up adding id: 1234',
    }));

    const api = new MylarAPI({ url: 'http://localhost:8090', apiKey: 'key' });
    await api.addComic('1234');

    assert.deepStrictEqual(getMock.mock.calls[0].arguments[1], {
      params: { apikey: 'key', cmd: 'addComic', id: '1234' },
    });
  });

  it('removeComic sends the comic id as the id param', async () => {
    const getMock = mockGet(async () => ({
      success: true,
      data: 'Successfully deleted Batman (2016) [1234]',
    }));

    const api = new MylarAPI({ url: 'http://localhost:8090', apiKey: 'key' });
    await api.removeComic('1234');

    assert.deepStrictEqual(getMock.mock.calls[0].arguments[1], {
      params: { apikey: 'key', cmd: 'delComic', id: '1234' },
    });
  });
});

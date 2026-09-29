import assert from 'node:assert/strict';
import { once } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { mkdtemp, open, rm, stat, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  getPreviewReadFlags,
  loadPreviewFile,
  normalizeServerBase,
  parseArgs,
  run,
  savePreviewFile,
} from './bookshelf-media-move.mjs';

const tempDirectories = [];
const makeTempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seerrng-media-move-'));
  tempDirectories.push(directory);
  return directory;
};

const readPreviewFile = async (path) => {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  );
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Bookshelf media-move CLI', () => {
  it('requires no-follow file opens before applying a saved preview', () => {
    assert.throws(
      () => getPreviewReadFlags('win32', { O_RDONLY: 0, O_NOFOLLOW: 0 }),
      /platform with O_NOFOLLOW support/
    );
  });

  it('defaults to preview and validates batches before making a request', () => {
    const options = parseArgs([
      '--service-id',
      '12',
      '--format',
      'audiobook',
      '--destination-root',
      '/media/audio',
      '--author-id',
      '41',
      '--author-id',
      '42',
    ]);
    assert.equal(options.apply, false);
    assert.deepEqual(options.authorIds, ['41', '42']);
    assert.throws(
      () =>
        parseArgs([
          '--service-id',
          '12',
          '--format',
          'ebook',
          '--destination-root',
          '/media/new',
          '--author-id',
          '41',
          '--author-id',
          '41',
        ]),
      /unique positive integers/
    );
    assert.throws(
      () => parseArgs(['--apply', '--preview-file', '/tmp/preview.json']),
      /--apply requires both/
    );
  });

  it('requires explicit confirmation and saved preview details for apply', () => {
    assert.deepEqual(
      parseArgs(['--apply', '--preview-file', '/tmp/preview.json', '--yes']),
      {
        authorIds: [],
        apply: true,
        yes: true,
        help: false,
        previewFile: '/tmp/preview.json',
      }
    );
    assert.throws(
      () =>
        parseArgs([
          '--apply',
          '--preview-file',
          '/tmp/preview.json',
          '--yes',
          '--service-id',
          '12',
        ]),
      /uses the saved preview details/
    );
  });

  it('keeps the configured URL path and rejects URL credentials or fragments', () => {
    assert.equal(
      normalizeServerBase('https://media.example.test/seerr/'),
      'https://media.example.test/seerr'
    );
    assert.throws(
      () => normalizeServerBase('https://user:pass@media.example.test'),
      /without credentials/
    );
    assert.throws(
      () => normalizeServerBase('https://media.example.test/#secret'),
      /without credentials/
    );
  });

  it('saves preview tokens in user-only files and binds them to one SeerrNG URL', async () => {
    const directory = await makeTempDirectory();
    const path = join(directory, 'move-preview.json');
    const record = {
      version: 1,
      serverBase: 'https://media.example.test',
      serviceId: 12,
      format: 'ebook',
      destinationRootPath: '/media/new',
      authorIds: [41, 42],
      previewToken: 'one-use-token',
      canMove: true,
    };
    const savedPath = await savePreviewFile(path, record);
    assert.equal(savedPath, path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      (await loadPreviewFile(path, record.serverBase)).previewToken,
      'one-use-token'
    );
    await assert.rejects(
      loadPreviewFile(path, 'https://another.example.test'),
      /belongs to another SeerrNG URL/
    );
    await assert.rejects(
      savePreviewFile(path, record),
      (error) => error.code === 'EEXIST'
    );
    assert.deepEqual(await loadPreviewFile(path, record.serverBase), record);
  });

  it('rejects symlinked previews and credential fields before applying', async () => {
    const directory = await makeTempDirectory();
    const target = join(directory, 'private-preview.json');
    const link = join(directory, 'move-preview.json');
    await savePreviewFile(target, {
      version: 1,
      serverBase: 'https://media.example.test',
      serviceId: 12,
      format: 'ebook',
      destinationRootPath: '/media/new',
      authorIds: [41],
      previewToken: 'one-use-token',
      canMove: true,
    });
    await symlink(target, link);

    await assert.rejects(
      loadPreviewFile(link, 'https://media.example.test'),
      /regular file, not a symlink/
    );

    const credentialRecord = JSON.parse(await readPreviewFile(target));
    credentialRecord.apiKey = 'unexpected-secret';
    await rm(target);
    await savePreviewFile(target, credentialRecord);
    await assert.rejects(
      loadPreviewFile(target, 'https://media.example.test'),
      /incomplete or belongs to another/
    );
  });

  it('previews, applies the saved batch, and reads command status through the admin API', async () => {
    const directory = await makeTempDirectory();
    const previewFile = join(directory, 'books.json');
    const requests = [];
    const server = createServer((req, res) => {
      void (async () => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({
          method: req.method,
          url: req.url,
          apiKey: req.headers['x-api-key'],
          body: body ? JSON.parse(body) : undefined,
        });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/base/api/v1/settings/readarr/12/media-move/preview') {
          res.end(
            JSON.stringify({
              previewToken: 'fresh-token',
              canMove: true,
              conflicts: [],
              authorCount: 1,
              authors: [],
            })
          );
        } else if (
          req.url === '/base/api/v1/settings/readarr/12/media-move/start'
        ) {
          res.statusCode = 202;
          res.end(
            JSON.stringify({
              command: {
                id: 91,
                name: 'MoveAuthorMediaBatch',
                status: 'queued',
              },
            })
          );
        } else if (
          req.url === '/base/api/v1/settings/readarr/12/media-move/commands/91'
        ) {
          res.end(
            JSON.stringify({
              command: {
                id: 91,
                name: 'MoveAuthorMediaBatch',
                status: 'completed',
              },
            })
          );
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ message: 'not found' }));
        }
      })().catch(() => {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: 'handler failed' }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const env = {
      SEERRNG_URL: `http://127.0.0.1:${address.port}/base/`,
      SEERRNG_API_KEY: 'admin-api-key',
    };

    try {
      assert.equal(
        await run(
          [
            '--service-id',
            '12',
            '--format',
            'ebook',
            '--destination-root',
            '/books/new',
            '--author-id',
            '41',
            '--preview-file',
            previewFile,
          ],
          env
        ),
        0
      );
      assert.equal(requests[0].apiKey, 'admin-api-key');
      assert.equal(requests[0].method, 'POST');
      assert.equal(
        requests[0].url,
        '/base/api/v1/settings/readarr/12/media-move/preview'
      );

      await run(['--apply', '--preview-file', previewFile, '--yes'], env);
      assert.equal(requests[1].body.previewToken, 'fresh-token');
      assert.equal(requests[1].body.authorIds[0], 41);
      await assert.rejects(
        stat(previewFile),
        (error) => error.code === 'ENOENT'
      );

      await run(['--service-id', '12', '--status', '91'], env);
      assert.equal(
        requests[2].url,
        '/base/api/v1/settings/readarr/12/media-move/commands/91'
      );
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

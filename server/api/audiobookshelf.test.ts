import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { it } from 'node:test';

import AudiobookshelfAPI from '@server/api/audiobookshelf';
import type { AudiobookshelfSettings } from '@server/lib/settings';

it('uses the Audiobookshelf user token and paginates a selected library', async () => {
  const received: { path: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    received.push({
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
    });
    response.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/abs/api/libraries') {
      response.end(
        JSON.stringify({
          libraries: [
            { id: 'books', name: 'Books', mediaType: 'book', numBooks: 2 },
            { id: 'podcasts', name: 'Podcasts', mediaType: 'podcast' },
          ],
        })
      );
      return;
    }

    if (url.pathname === '/abs/api/libraries/books/items') {
      response.end(
        JSON.stringify({
          results: [{ id: 'item-1', mediaType: 'book' }],
          total: 2,
          limit: 1,
          page: 0,
        })
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const settings: AudiobookshelfSettings = {
    id: 1,
    name: 'Test Audiobookshelf',
    hostname: '127.0.0.1',
    port: address.port,
    apiKey: 'abs-user-token',
    useSsl: false,
    baseUrl: '/abs',
    libraryId: 'books',
    libraryName: 'Books',
    syncEnabled: true,
  };

  try {
    const api = new AudiobookshelfAPI(settings);
    assert.equal((await api.getLibraries()).length, 2);
    const page = await api.getLibraryItems('books', 0, 1);

    assert.equal(page.total, 2);
    assert.equal(page.results[0]?.id, 'item-1');
    assert.deepEqual(received, [
      {
        path: '/abs/api/libraries',
        authorization: 'Bearer abs-user-token',
      },
      {
        path: '/abs/api/libraries/books/items?page=0&limit=1',
        authorization: 'Bearer abs-user-token',
      },
    ]);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it('builds an Audiobookshelf item link without exposing the API token', () => {
  const url = AudiobookshelfAPI.buildItemUrl(
    {
      id: 1,
      name: 'Test Audiobookshelf',
      hostname: 'abs.internal',
      port: 13378,
      apiKey: 'abs-user-token',
      useSsl: true,
      baseUrl: '/audio',
      externalUrl: 'https://listen.example.test/',
      libraryId: 'books',
      libraryName: 'Books',
      syncEnabled: true,
    },
    'item/with space'
  );

  assert.equal(
    url,
    'https://listen.example.test/audio/item/item%2Fwith%20space'
  );
  assert.equal(url.includes('abs-user-token'), false);
});

it('does not duplicate a URL Base already present in the external URL', () => {
  const url = AudiobookshelfAPI.buildItemUrl(
    {
      id: 1,
      name: 'Test Audiobookshelf',
      hostname: 'abs.internal',
      port: 13378,
      apiKey: 'abs-user-token',
      useSsl: true,
      baseUrl: '/audio/',
      externalUrl: 'https://listen.example.test/audio/?session=remove-me',
      libraryId: 'books',
      libraryName: 'Books',
      syncEnabled: true,
    },
    'item-1'
  );

  assert.equal(url, 'https://listen.example.test/audio/item/item-1');
});

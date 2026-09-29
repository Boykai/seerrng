import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import QuestarrNGAPI from './questarrng';

it('requests exact platform release dates from the SeerrNG catalog contract', async () => {
  let requestPath = '';
  const server = createServer((request, response) => {
    assert.equal(request.headers['x-api-key'], 'questarr-contract-test');
    const url = new URL(request.url ?? '/', 'http://localhost');
    requestPath = `${url.pathname}${url.search}`;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'igdb-42',
        igdbId: 42,
        platformReleaseDate: '2026-10-12',
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const api = new QuestarrNGAPI({
      hostname: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      baseUrl: '',
      useSsl: false,
      apiKey: 'questarr-contract-test',
    });
    const game = await api.getCatalogGame(42, 6);

    assert.equal(game.igdbId, 42);
    assert.equal(game.platformReleaseDate, '2026-10-12');
    const url = new URL(requestPath, 'http://localhost');
    assert.equal(url.pathname, '/api/integration/seerrng/v1/catalog/games/42');
    assert.equal(url.searchParams.get('platformId'), '6');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

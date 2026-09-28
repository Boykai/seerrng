import {
  DEFAULT_PROWLARR_CATEGORY_MAPPINGS,
  defaultProwlarrCategoryMappings,
} from '@server/constants/prowlarr';
import {
  sanitizeProwlarrSearchResource,
  summarizeProwlarrCoverage,
} from '@server/lib/prowlarr';
import type { ProwlarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import ProwlarrAPI from './prowlarr';

const settings = (port: number): ProwlarrSettings => ({
  hostname: '127.0.0.1',
  port,
  useSsl: false,
  baseUrl: '/prowlarr',
  apiKey: 'test-prowlarr-key',
  categoryMappings: defaultProwlarrCategoryMappings(),
});

it('queries Prowlarr with repeated category parameters and a header API key', async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    assert.equal(url.pathname, '/prowlarr/api/v1/search');
    assert.equal(url.searchParams.get('query'), 'Dune');
    assert.equal(url.searchParams.get('type'), 'search');
    assert.equal(url.searchParams.get('limit'), '50');
    assert.equal(url.searchParams.get('offset'), '50');
    assert.deepEqual(url.searchParams.getAll('categories'), ['2000', '2010']);
    assert.equal(request.headers['x-api-key'], 'test-prowlarr-key');
    assert.equal(url.searchParams.has('apikey'), false);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify([{ title: 'Dune 2021' }]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const api = new ProwlarrAPI(
      settings((server.address() as AddressInfo).port)
    );
    const results = await api.search('Dune', [2000, 2010], 50, 50);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Dune 2021');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('uses the configured reverse-proxy base path and API v1 prefix', () => {
  assert.equal(
    ProwlarrAPI.buildUrl({
      hostname: 'prowlarr.local',
      port: 9696,
      useSsl: true,
      baseUrl: '/indexers',
    }),
    'https://prowlarr.local:9696/indexers/api/v1'
  );
});

it('uses media-specific standard categories across every search medium', () => {
  const mappings = defaultProwlarrCategoryMappings();

  assert.deepEqual(mappings.music, [3000]);
  assert.deepEqual(mappings.ebook, [7020]);
  assert.deepEqual(mappings.audiobook, [3030]);
  assert.deepEqual(mappings.comic, [7030]);
  assert.deepEqual(mappings.magazine, [7010]);
  assert.deepEqual(
    mappings.retro,
    [1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1110, 1120, 1130]
  );
  assert.deepEqual(mappings.modern, [1090, 1140, 1180]);
  assert.deepEqual(mappings.game, [4000]);
});

it('counts searchable indexers by selected standard category groups', () => {
  const coverage = summarizeProwlarrCoverage(
    [
      {
        id: 1,
        name: 'Video and Books',
        enable: true,
        supportsSearch: true,
        protocol: 'torrent',
        capabilities: {
          categories: [
            { id: 2010, name: 'Movies/Foreign' },
            {
              id: 7000,
              name: 'Books',
              subCategories: [{ id: 7030, name: 'Books/Comics' }],
            },
          ],
        },
      },
      {
        id: 2,
        name: 'Disabled Music',
        enable: false,
        supportsSearch: true,
        protocol: 'torrent',
        capabilities: { categories: [{ id: 3000, name: 'Audio' }] },
      },
      {
        id: 3,
        name: 'RSS only',
        enable: true,
        supportsSearch: false,
        protocol: 'usenet',
        capabilities: { categories: [{ id: 5000, name: 'TV' }] },
      },
      {
        id: 4,
        name: 'Audio indexer',
        enable: true,
        supportsSearch: true,
        protocol: 'usenet',
        capabilities: {
          categories: [
            { id: 3010, name: 'Audio/MP3' },
            { id: 3030, name: 'Audio/Audiobook' },
            { id: 3040, name: 'Audio/Lossless' },
          ],
        },
      },
    ],
    DEFAULT_PROWLARR_CATEGORY_MAPPINGS
  );

  assert.equal(coverage.totalIndexers, 4);
  assert.equal(coverage.enabledSearchableIndexers, 2);
  assert.equal(coverage.categories.movie, 1);
  assert.equal(coverage.categories.comic, 1);
  assert.equal(coverage.categories.ebook, 0);
  assert.equal(coverage.categories.audiobook, 1);
  assert.equal(coverage.categories.music, 1);
  assert.equal(coverage.categories.tv, 0);
});

it('sanitizes release metadata and strips query secrets from info links', () => {
  const result = sanitizeProwlarrSearchResource({
    title: '  Example release  ',
    indexer: 'Example indexer',
    indexerId: 5,
    size: 1024,
    seeders: 12,
    leechers: null,
    grabs: 22,
    protocol: 'Torrent',
    publishDate: '2026-09-28T12:00:00.000Z',
    infoUrl:
      'https://tracker.example/details.php?id=5&apikey=private&pass_key=private&view=full',
    categories: [{ id: 7030, name: 'Books/Comics' }],
  });

  assert.deepEqual(result, {
    title: 'Example release',
    indexer: 'Example indexer',
    indexerId: 5,
    size: 1024,
    seeders: 12,
    leechers: null,
    grabs: 22,
    protocol: 'torrent',
    publishDate: '2026-09-28T12:00:00.000Z',
    infoUrl: 'https://tracker.example/details.php?id=5&view=full',
    categories: [{ id: 7030, name: 'Books/Comics' }],
  });

  const unsafeLink = sanitizeProwlarrSearchResource({
    title: 'Unsafe',
    infoUrl: 'javascript:alert(1)',
  });
  assert.equal(unsafeLink.infoUrl, null);
  assert.equal('downloadUrl' in unsafeLink, false);
  assert.equal('magnetUrl' in unsafeLink, false);
});

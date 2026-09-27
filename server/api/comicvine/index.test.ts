import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import ComicVineAPI from '@server/api/comicvine';

type MockableComicVine = {
  get: (
    endpoint: string,
    options?: { params?: Record<string, unknown> },
    ttl?: number
  ) => Promise<unknown>;
};

const mockGet = (implementation: (endpoint: string) => Promise<unknown>) =>
  mock.method(
    ComicVineAPI.prototype as unknown as MockableComicVine,
    'get',
    implementation
  );

describe('ComicVineAPI.searchVolumes', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('parses a well-formed search response', async () => {
    mockGet(async () => ({
      error: 'OK',
      limit: 20,
      offset: 0,
      number_of_page_results: 1,
      number_of_total_results: 1,
      status_code: 1,
      results: [
        {
          id: 1234,
          name: 'Batman',
          aliases: 'Bat-Man\nThe Dark Knight',
          start_year: '1940',
          count_of_issues: 904,
          publisher: { id: 10, name: 'DC Comics' },
          image: {
            small_url: 'https://comicvine.gamespot.com/a/uploads/small/1.jpg',
          },
          deck: 'A vigilante.',
          description: '<p>Full description</p>',
          site_detail_url: 'https://comicvine.gamespot.com/batman/4050-1234/',
          resource_type: 'volume',
        },
      ],
    }));

    const api = new ComicVineAPI('key');
    const response = await api.searchVolumes({ query: 'Batman' });

    assert.strictEqual(response.results.length, 1);
    assert.deepStrictEqual(response.results[0], {
      id: 1234,
      name: 'Batman',
      aliases: ['Bat-Man', 'The Dark Knight'],
      start_year: '1940',
      count_of_issues: 904,
      publisher: { id: 10, name: 'DC Comics' },
      image: {
        icon_url: undefined,
        medium_url: undefined,
        screen_url: undefined,
        small_url: 'https://comicvine.gamespot.com/a/uploads/small/1.jpg',
        super_url: undefined,
        thumb_url: undefined,
        tiny_url: undefined,
        original_url: undefined,
      },
      deck: 'A vigilante.',
      description: '<p>Full description</p>',
      site_detail_url: 'https://comicvine.gamespot.com/batman/4050-1234/',
      resource_type: 'volume',
    });
  });

  it('drops results missing a required id or name', async () => {
    mockGet(async () => ({
      error: 'OK',
      limit: 20,
      offset: 0,
      number_of_page_results: 2,
      number_of_total_results: 2,
      status_code: 1,
      results: [
        { id: 1, name: 'Has both' },
        { id: 2 },
        { name: 'Missing id' },
        'not even an object',
      ],
    }));

    const api = new ComicVineAPI('key');
    const response = await api.searchVolumes({ query: 'x' });

    assert.strictEqual(response.results.length, 1);
    assert.strictEqual(response.results[0].name, 'Has both');
  });

  it('rejects image and site URLs on hosts outside the ComicVine allowlist', async () => {
    mockGet(async () => ({
      error: 'OK',
      limit: 20,
      offset: 0,
      number_of_page_results: 1,
      number_of_total_results: 1,
      status_code: 1,
      results: [
        {
          id: 1,
          name: 'Spoofed',
          image: { small_url: 'https://evil.example.com/x.jpg' },
          site_detail_url: 'https://evil.example.com/batman/',
        },
      ],
    }));

    const api = new ComicVineAPI('key');
    const response = await api.searchVolumes({ query: 'x' });

    assert.strictEqual(response.results[0].image?.small_url, undefined);
    assert.strictEqual(response.results[0].site_detail_url, undefined);
  });

  it('throws when the response is not an object', async () => {
    mockGet(async () => null);

    const api = new ComicVineAPI('key');
    await assert.rejects(() => api.searchVolumes({ query: 'x' }));
  });
});

describe('ComicVineAPI.getVolume', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('requests the resource-type-prefixed path and includes issues', async () => {
    const getMock = mockGet(async () => ({
      error: 'OK',
      status_code: 1,
      results: {
        id: 1234,
        name: 'Batman',
        resource_type: 'volume',
        issues: [{ id: 1, name: 'Issue #1', issue_number: '1' }, { id: 2 }],
      },
    }));

    const api = new ComicVineAPI('key');
    const volume = await api.getVolume(1234);

    assert.strictEqual(
      getMock.mock.calls[0].arguments[0],
      '/volume/4050-1234/'
    );
    assert.strictEqual(volume?.issues?.length, 2);
    assert.strictEqual(volume?.issues?.[0].issue_number, '1');
  });

  it('rejects a non-positive-integer volume id', async () => {
    const api = new ComicVineAPI('key');
    await assert.rejects(() => api.getVolume(-1));
    await assert.rejects(() => api.getVolume(1.5));
  });

  it('returns undefined when the volume is not found', async () => {
    mockGet(async () => ({
      error: 'Not Found',
      status_code: 101,
      results: [],
    }));

    const api = new ComicVineAPI('key');
    const volume = await api.getVolume(999);

    assert.strictEqual(volume, undefined);
  });
});

describe('ComicVineAPI.getVolumeIssues', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('fetches a bounded volume page and sanitizes issue art', async () => {
    const getMock = mockGet(async () => ({
      offset: 20,
      number_of_total_results: 42,
      results: [
        {
          id: 123,
          name: 'The Return',
          issue_number: '21',
          cover_date: '2025-09-01',
          image: {
            medium_url: 'https://comicvine.gamespot.com/a/uploads/cover.jpg',
          },
        },
        {
          id: 124,
          image: { medium_url: 'https://evil.example.com/cover.jpg' },
        },
        { name: 'No ID' },
      ],
    }));

    const response = await new ComicVineAPI('key').getVolumeIssues({
      volumeId: 4567,
      page: 2,
    });

    assert.strictEqual(getMock.mock.calls[0].arguments[0], '/issues/');
    assert.deepStrictEqual(getMock.mock.calls[0].arguments[1], {
      params: {
        filter: 'volume:4567',
        limit: 20,
        offset: 20,
        field_list: 'id,name,issue_number,cover_date,image',
      },
    });
    assert.strictEqual(response.number_of_total_results, 42);
    assert.strictEqual(response.results.length, 2);
    assert.strictEqual(response.results[0].issue_number, '21');
    assert.strictEqual(response.results[1].image, undefined);
  });

  it('rejects invalid volume IDs and pages', async () => {
    const api = new ComicVineAPI('key');
    await assert.rejects(() => api.getVolumeIssues({ volumeId: 0 }));
    await assert.rejects(() => api.getVolumeIssues({ volumeId: 1, page: 0 }));
  });
});

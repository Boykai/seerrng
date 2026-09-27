import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import GoogleBooksAPI from '@server/api/googlebooks';

type MockableGoogleBooks = {
  get: (
    endpoint: string,
    options?: { params?: Record<string, unknown> },
    ttl?: number
  ) => Promise<unknown>;
};

const mockGet = (
  implementation: (
    endpoint: string,
    options?: { params?: Record<string, unknown> },
    ttl?: number
  ) => Promise<unknown>
) =>
  mock.method(
    GoogleBooksAPI.prototype as unknown as MockableGoogleBooks,
    'get',
    implementation
  );

describe('GoogleBooksAPI.searchMagazines', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('searches magazine-only title results with bounded pagination', async () => {
    let request: {
      endpoint: string;
      params?: Record<string, unknown>;
      ttl?: number;
    } = { endpoint: '' };
    mockGet(async (endpoint, options, ttl) => {
      request = { endpoint, params: options?.params, ttl };
      return {
        totalItems: 3,
        items: [
          {
            id: '_TIME-2026',
            volumeInfo: {
              title: 'Time',
              publisher: 'Example Publisher',
              publishedDate: '2026-09',
              printType: 'MAGAZINE',
              imageLinks: {
                thumbnail:
                  'http://books.google.com/books/content?id=_TIME-2026&img=1',
              },
              infoLink: 'https://books.google.com/books?id=_TIME-2026',
            },
          },
          {
            id: 'not-a-magazine',
            volumeInfo: { title: 'A book', printType: 'BOOK' },
          },
          {
            id: 'unsafe-cover',
            volumeInfo: {
              title: 'Safe result',
              printType: 'MAGAZINE',
              imageLinks: { thumbnail: 'https://evil.example/cover.jpg' },
            },
          },
        ],
      };
    });

    const response = await new GoogleBooksAPI('test-key').searchMagazines({
      query: 'Time',
      page: 3,
      limit: 80,
    });

    assert.strictEqual(request.endpoint, '/volumes');
    assert.deepStrictEqual(request.params, {
      q: 'intitle:Time',
      printType: 'magazines',
      orderBy: 'relevance',
      startIndex: 80,
      maxResults: 40,
    });
    assert.strictEqual(request.ttl, 300);
    assert.strictEqual(response.totalItems, 3);
    assert.deepStrictEqual(response.results, [
      {
        id: '_TIME-2026',
        title: 'Time',
        publisher: 'Example Publisher',
        publishedDate: '2026-09',
        description: undefined,
        imageUrl: 'https://books.google.com/books/content?id=_TIME-2026&img=1',
        infoUrl: 'https://books.google.com/books?id=_TIME-2026',
      },
      {
        id: 'unsafe-cover',
        title: 'Safe result',
        publisher: undefined,
        publishedDate: undefined,
        description: undefined,
        imageUrl: undefined,
        infoUrl: undefined,
      },
    ]);
  });

  it('does not call Google Books for a blank title query', async () => {
    mockGet(async () => {
      assert.fail('A blank magazine query must not call the provider.');
    });

    assert.deepStrictEqual(
      await new GoogleBooksAPI('test-key').searchMagazines({ query: '  ' }),
      { totalItems: 0, results: [] }
    );
  });

  it('rejects invalid search responses', async () => {
    mockGet(async () => 'invalid');

    await assert.rejects(
      new GoogleBooksAPI('test-key').searchMagazines({ query: 'science' }),
      /Google Books returned an invalid search response/
    );
  });
});

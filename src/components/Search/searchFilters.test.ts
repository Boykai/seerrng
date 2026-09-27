import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getMusicSearchParams,
  getSearchCategoryQuery,
  getSearchEndpoint,
  getSearchResultFilter,
  isSearchDataReady,
  matchesSearchResultFilter,
} from './searchFilters';

describe('contextual global search filters', () => {
  it('routes active filters to a fresh scoped catalogue search with the main keyword', () => {
    for (const [category, endpoint] of [
      ['movie', 'movies'],
      ['tv', 'tv'],
      ['book', 'books'],
      ['audiobook', 'books'],
      ['music', 'music'],
    ] as const) {
      assert.equal(
        getSearchEndpoint(category, 'title', true),
        `/api/v1/discover/${endpoint}`
      );
    }
    assert.deepEqual(
      getMusicSearchParams({
        artist: 'Madonna',
        artistId: 'id',
        primaryReleaseDateGte: '1998-01-01',
        query: 'title',
      }),
      { artist: 'Madonna', artistId: 'id', primaryReleaseDateGte: '1998-01-01' }
    );
    assert.deepEqual(
      getSearchCategoryQuery(
        { query: 'title', artist: 'Madonna', artistId: 'id' },
        { type: 'movie' }
      ),
      { query: 'title', type: 'movie' }
    );
  });
  it('uses combined search for All and the matching discovery source when no main query exists', () => {
    assert.equal(getSearchEndpoint('all'), '/api/v1/search');
    assert.equal(getSearchEndpoint('movie'), '/api/v1/discover/movies');
    assert.equal(getSearchEndpoint('tv'), '/api/v1/discover/tv');
    assert.equal(getSearchEndpoint('music'), '/api/v1/discover/music');
    assert.equal(getSearchEndpoint('book'), '/api/v1/discover/books');
    assert.equal(getSearchEndpoint('audiobook'), '/api/v1/discover/books');
  });

  it('keeps a populated main search on the combined search source while media filters narrow it', () => {
    assert.equal(getSearchEndpoint('music', 'madonna'), '/api/v1/search');
    assert.equal(getSearchEndpoint('movie', 'iron man'), '/api/v1/search');
    assert.equal(getSearchEndpoint('book', 'stephen king'), '/api/v1/search');
  });

  it('requires a keyword for All but allows a selected media type to use its discovery filters', () => {
    assert.equal(
      isSearchDataReady({ routerReady: true, category: 'all', query: '' }),
      false
    );
    assert.equal(
      isSearchDataReady({
        routerReady: true,
        category: 'all',
        query: 'madonna',
      }),
      true
    );
    assert.equal(
      isSearchDataReady({ routerReady: true, category: 'music', query: '' }),
      true
    );
  });

  it('preserves the main query but removes stale contextual and sort state when media type changes', () => {
    assert.deepEqual(
      getSearchCategoryQuery(
        {
          query: 'bedtime stories',
          type: 'music',
          genre: 'pop',
          releaseType: 'Album',
          resultFilter: 'stories',
          sort: 'artist',
          order: 'asc',
        },
        { type: 'book', format: 'audiobook' }
      ),
      {
        query: 'bedtime stories',
        type: 'book',
        format: 'audiobook',
      }
    );
  });

  it('does not pre-populate the result filter from the main search query', () => {
    assert.equal(getSearchResultFilter({ query: 'iron man' }), '');
    assert.equal(
      getSearchResultFilter({ query: 'iron man', resultFilter: 'tony' }),
      'tony'
    );
  });

  it('filters returned results independently of the main search query', () => {
    assert.equal(
      matchesSearchResultFilter(['Iron Man', 'Robert Downey Jr.'], 'iron'),
      true
    );
    assert.equal(
      matchesSearchResultFilter(['Iron Man', 'Robert Downey Jr.'], 'thor'),
      false
    );
    assert.equal(matchesSearchResultFilter(['Iron Man'], ''), true);
  });

  it('narrows Madonna music results to an album without replacing the main search', () => {
    assert.equal(getSearchEndpoint('music', 'madonna'), '/api/v1/search');
    assert.equal(
      matchesSearchResultFilter(['Like a Prayer', 'Madonna'], 'prayer'),
      true
    );
    assert.equal(
      matchesSearchResultFilter(['Bedtime Stories', 'Madonna'], 'prayer'),
      false
    );
  });
});

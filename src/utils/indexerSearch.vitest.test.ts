import { describe, expect, it } from 'vitest';
import { getIndexerSearchHref } from './indexerSearch';

describe('getIndexerSearchHref', () => {
  it('encodes the media category and title for a prefilled search', () => {
    expect(getIndexerSearchHref('audiobook', '  Project Hail Mary  ')).toBe(
      '/indexer-search?category=audiobook&query=Project+Hail+Mary'
    );
  });

  it('keeps each supported media category in the detail search link', () => {
    const categories = [
      'movie',
      'tv',
      'music',
      'ebook',
      'audiobook',
      'comic',
      'magazine',
      'retro',
      'modern',
      'game',
    ] as const;

    for (const category of categories) {
      expect(getIndexerSearchHref(category, 'Example title')).toContain(
        `category=${category}`
      );
    }
  });

  it('removes control characters and bounds the title query', () => {
    expect(getIndexerSearchHref('movie', `Dune\n${'x'.repeat(300)}`)).toBe(
      `/indexer-search?category=movie&query=${'Dune+' + 'x'.repeat(251)}`
    );
  });

  it('does not create a search link for an empty or one-character title', () => {
    expect(getIndexerSearchHref('comic', ' ')).toBeUndefined();
    expect(getIndexerSearchHref('comic', 'A')).toBeUndefined();
  });
});

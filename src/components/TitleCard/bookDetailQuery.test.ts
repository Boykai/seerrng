import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { getTitleCardBookDetailQuery } from './bookDetailQuery';

describe('getTitleCardBookDetailQuery', () => {
  it('keeps the title needed to resolve Bookshelf-generated book IDs', () => {
    deepStrictEqual(
      getTitleCardBookDetailQuery({
        canonicalId: 'bookshelf:0:Mzc0NTQx',
        preferredBookFormat: 'ebook',
        title: 'The Fellowship of the Ring',
      }),
      {
        format: 'ebook',
        lookupTitle: 'The Fellowship of the Ring',
      }
    );
  });

  it('does not add a Bookshelf lookup title to Open Library links', () => {
    deepStrictEqual(
      getTitleCardBookDetailQuery({
        canonicalId: 'OL45804W',
        preferredBookFormat: 'audiobook',
        title: 'Fantastic Mr Fox',
      }),
      { format: 'audiobook' }
    );
  });

  it('omits the query when an Open Library card has no preferred format', () => {
    strictEqual(
      getTitleCardBookDetailQuery({
        canonicalId: 'OL45804W',
        title: 'Fantastic Mr Fox',
      }),
      undefined
    );
  });
});

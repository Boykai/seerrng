import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getSearchTerms,
  matchesAllSearchTerms,
  toBooleanAndQuery,
  toFieldedBooleanAndQuery,
  toMusicAlbumRefinementQuery,
} from './searchTerms';

describe('search terms', () => {
  it('uses implicit AND semantics and ignores an explicit AND operator', () => {
    assert.deepStrictEqual(getSearchTerms('Judds AND hits'), ['judds', 'hits']);
    assert.strictEqual(toBooleanAndQuery('Judds AND hits'), 'judds AND hits');
  });

  it('preserves quoted phrases as a single term', () => {
    assert.deepStrictEqual(getSearchTerms('"greatest hits" judds'), [
      'greatest hits',
      'judds',
    ]);
    assert.strictEqual(
      toBooleanAndQuery('"greatest hits" judds'),
      '"greatest hits" AND judds'
    );
  });

  it('requires every term while allowing them in different fields', () => {
    assert.strictEqual(
      matchesAllSearchTerms(['Greatest Hits', 'The Judds'], 'judds hits'),
      true
    );
    assert.strictEqual(
      matchesAllSearchTerms(['Greatest Hits', 'Another Artist'], 'judds hits'),
      false
    );
  });

  it('builds field-limited AND queries without searching hidden metadata', () => {
    assert.strictEqual(
      toFieldedBooleanAndQuery('windows 11', ['title', 'author']),
      '(title:"windows" OR author:"windows") AND (title:"11" OR author:"11")'
    );
  });

  it('keeps the main music search while narrowing album titles', () => {
    assert.strictEqual(
      toMusicAlbumRefinementQuery('Madonna', 'Prayer'),
      '(releasegroup:madonna OR artist:madonna OR tag:madonna) AND releasegroup:prayer'
    );
    assert.strictEqual(
      toMusicAlbumRefinementQuery('Taylor Swift', 'Tortured Poets'),
      '(releasegroup:taylor OR artist:taylor OR tag:taylor) AND (releasegroup:swift OR artist:swift OR tag:swift) AND releasegroup:tortured AND releasegroup:poets'
    );
  });
});

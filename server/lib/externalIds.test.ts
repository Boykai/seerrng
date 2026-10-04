import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import { MediaIdentifierProvider } from '@server/entity/MediaIdentifier';
import {
  MAX_MUSICBRAINZ_BATCH_IDS,
  isValidExternalMediaId,
  normalizeExternalMediaId,
  prepareMusicBrainzBatchIds,
} from './externalIds';

describe('prepareMusicBrainzBatchIds', () => {
  it('normalizes, deduplicates, validates, and caps SQL-bound IDs', () => {
    const ids = prepareMusicBrainzBatchIds([
      ' ABC ',
      'abc',
      123,
      'x'.repeat(129),
      '../search',
      'album?redirect=/account',
      ...Array.from(
        { length: MAX_MUSICBRAINZ_BATCH_IDS + 10 },
        (_, index) => `id-${index}`
      ),
    ]);

    assert.strictEqual(ids[0], 'abc');
    assert.ok(!ids.includes('../search'));
    assert.strictEqual(ids.length, MAX_MUSICBRAINZ_BATCH_IDS);
    assert.deepStrictEqual(prepareMusicBrainzBatchIds({}), []);
  });
});

describe('comic external id validation', () => {
  it('accepts a plain ComicVine numeric id with no provider or an explicit COMICVINE provider', () => {
    assert.strictEqual(isValidExternalMediaId('12345', MediaType.COMIC), true);
    assert.strictEqual(
      isValidExternalMediaId(
        '12345',
        MediaType.COMIC,
        MediaIdentifierProvider.COMICVINE
      ),
      true
    );
  });

  it('rejects a non-numeric id or an unrelated provider', () => {
    assert.strictEqual(isValidExternalMediaId('abc', MediaType.COMIC), false);
    assert.strictEqual(
      isValidExternalMediaId(
        '12345',
        MediaType.COMIC,
        MediaIdentifierProvider.OPENLIBRARY
      ),
      false
    );
  });

  it('passes a comic id through unchanged', () => {
    assert.strictEqual(
      normalizeExternalMediaId(' 12345 ', MediaType.COMIC),
      '12345'
    );
  });
});

describe('manga external id validation', () => {
  it('accepts a positive AniList id with no provider or an explicit ANILIST provider', () => {
    assert.strictEqual(isValidExternalMediaId('30013', MediaType.MANGA), true);
    assert.strictEqual(
      isValidExternalMediaId(
        ' 30013 ',
        MediaType.MANGA,
        MediaIdentifierProvider.ANILIST
      ),
      true
    );
  });

  it('rejects zero, non-numeric, oversized ids and other providers', () => {
    for (const id of ['0', '', 'abc', '-1', '1.5', '1e3', '1000000001']) {
      assert.strictEqual(
        isValidExternalMediaId(id, MediaType.MANGA),
        false,
        id
      );
    }
    assert.strictEqual(
      isValidExternalMediaId(
        '30013',
        MediaType.MANGA,
        MediaIdentifierProvider.COMICVINE
      ),
      false
    );
  });

  it('canonicalizes a manga id to the String(n) catalog form', () => {
    assert.strictEqual(
      normalizeExternalMediaId(' 0030013 ', MediaType.MANGA),
      '30013'
    );
    assert.strictEqual(
      normalizeExternalMediaId(
        '30013',
        MediaType.MANGA,
        MediaIdentifierProvider.ANILIST
      ),
      '30013'
    );
    assert.strictEqual(
      normalizeExternalMediaId(' abc ', MediaType.MANGA),
      'abc'
    );
  });
});

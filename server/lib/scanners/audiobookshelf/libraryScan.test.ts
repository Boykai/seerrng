import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUDIOBOOKSHELF_MAX_LIBRARY_ITEMS,
  getCompleteAudiobookshelfItemIds,
} from '@server/lib/scanners/audiobookshelf/libraryScan';

describe('Audiobookshelf library scan completeness', () => {
  it('accepts a complete page set with normalized unique item IDs', () => {
    const ids = getCompleteAudiobookshelfItemIds(
      [{ id: ' item-1 ' }, { id: 'item-2' }],
      2
    );

    assert.deepEqual([...(ids ?? [])], ['item-1', 'item-2']);
  });

  it('rejects incomplete, duplicate, or malformed item IDs', () => {
    assert.equal(
      getCompleteAudiobookshelfItemIds([{ id: 'item-1' }], 2),
      undefined
    );
    assert.equal(
      getCompleteAudiobookshelfItemIds([{ id: 'item-1' }, { id: 'item-1' }], 2),
      undefined
    );
    assert.equal(
      getCompleteAudiobookshelfItemIds([{ id: '   ' }], 1),
      undefined
    );
  });

  it('rejects totals above the bounded library scan limit', () => {
    assert.equal(
      getCompleteAudiobookshelfItemIds(
        [],
        AUDIOBOOKSHELF_MAX_LIBRARY_ITEMS + 1
      ),
      undefined
    );
  });
});

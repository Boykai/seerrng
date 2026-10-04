import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import {
  getMangaWatchlistBatch,
  getMangaWatchlistId,
} from './mangaWatchlistBatches';

const manga = (externalId: string) => ({
  mediaType: 'manga' as const,
  externalId,
});
const comic = { mediaType: 'comic' as const, externalId: '4050-1' };

describe('getMangaWatchlistId', () => {
  it('reads a positive AniList id from a manga watchlist item', () => {
    strictEqual(getMangaWatchlistId(manga('30013')), 30013);
  });

  it('ignores other media types and ids that are not AniList ids', () => {
    const invalid: Pick<WatchlistItem, 'mediaType' | 'externalId'>[] = [
      { mediaType: 'comic', externalId: '30013' },
      { mediaType: 'manga' },
      manga('0'),
      manga('-1'),
      manga('1.5'),
      manga('1e3'),
      manga('99999999999999999999'),
    ];
    for (const item of invalid) {
      strictEqual(getMangaWatchlistId(item), undefined);
    }
  });
});

describe('getMangaWatchlistBatch', () => {
  it('loads the manga of one page together and skips other items', () => {
    const items = [manga('1'), comic, manga('2')];

    deepStrictEqual(getMangaWatchlistBatch(items, 0), [1, 2]);
    deepStrictEqual(getMangaWatchlistBatch(items, 2), [1, 2]);
  });

  it('keeps the batches of earlier pages unchanged when another page loads', () => {
    const firstPage = Array.from({ length: 20 }, (_item, index) =>
      manga(String(index + 1))
    );
    const items = [...firstPage, manga('21'), comic, manga('22')];

    deepStrictEqual(
      getMangaWatchlistBatch(items, 19),
      getMangaWatchlistBatch(firstPage, 19)
    );
    strictEqual(getMangaWatchlistBatch(items, 0).length, 20);
    deepStrictEqual(getMangaWatchlistBatch(items, 20), [21, 22]);
  });
});

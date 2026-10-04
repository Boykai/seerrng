import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReleaseCalendarItem } from '@server/lib/releaseCalendar/normalize';
import { releaseCalendarHref } from './releaseCalendarLink';

const item = (fields: Partial<ReleaseCalendarItem>): ReleaseCalendarItem => ({
  id: 'entry',
  source: 'radarr',
  mediaType: 'movie',
  title: 'Calendar entry',
  startsAt: '2026-10-01T00:00:00.000Z',
  dateType: 'digital',
  allDay: true,
  available: false,
  is4k: false,
  ...fields,
});

describe('releaseCalendarHref', () => {
  it('links a manga entry to its details page by AniList ID', () => {
    assert.equal(
      releaseCalendarHref(
        item({
          source: 'suwayomi',
          mediaType: 'manga',
          dateType: 'chapter',
          mangaId: 9101,
          chapterCount: 3,
        })
      ),
      '/manga/9101'
    );
  });

  it('keeps the existing links for every other media type', () => {
    assert.equal(
      releaseCalendarHref(
        item({ mediaType: 'comic', source: 'mylar', comicId: '50 3' })
      ),
      '/comic/50%203'
    );
    assert.equal(
      releaseCalendarHref(
        item({
          mediaType: 'magazine',
          source: 'lazylibrarian',
          magazineTitle: 'Calendar magazine',
        })
      ),
      '/magazine/Calendar%20magazine'
    );
    assert.equal(
      releaseCalendarHref(
        item({
          mediaType: 'book',
          source: 'readarr',
          title: 'A & B',
          bookId: 'OL1W',
          bookFormat: 'audiobook',
        })
      ),
      '/book/OL1W?format=audiobook&lookupTitle=A%20%26%20B'
    );
    assert.equal(
      releaseCalendarHref(
        item({ mediaType: 'book', source: 'readarr', bookId: 'OL1W' })
      ),
      '/book/OL1W?format=ebook&lookupTitle=Calendar%20entry'
    );
    assert.equal(
      releaseCalendarHref(
        item({
          mediaType: 'music',
          source: 'lidarr',
          mbId: ' ABCDEF01-0000-4000-8000-000000000001 ',
        })
      ),
      '/music/abcdef01-0000-4000-8000-000000000001'
    );
    assert.equal(
      releaseCalendarHref(
        item({
          mediaType: 'software',
          source: 'questarr',
          softwareCategory: 'game',
          igdbId: 42,
        })
      ),
      '/software?category=game&game=42'
    );
    assert.equal(releaseCalendarHref(item({ tmdbId: 7 })), '/movie/7');
    assert.equal(
      releaseCalendarHref(item({ mediaType: 'tv', tmdbId: 8 })),
      '/tv/8'
    );
  });

  it('returns no link when an entry has no usable identity', () => {
    assert.equal(releaseCalendarHref(item({})), undefined);
    assert.equal(
      releaseCalendarHref(
        item({ mediaType: 'manga', source: 'suwayomi', dateType: 'chapter' })
      ),
      undefined
    );
    assert.equal(
      releaseCalendarHref(
        item({ mediaType: 'manga', source: 'suwayomi', mangaId: 0 })
      ),
      undefined
    );
    assert.equal(
      releaseCalendarHref(
        item({ mediaType: 'software', source: 'questarr', igdbId: 42 })
      ),
      undefined
    );
  });
});

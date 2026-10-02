import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getMangaImageUrl } from './mangaImages';

describe('manga image URLs', () => {
  it('routes AniList covers and banners through the image proxy', () => {
    assert.equal(
      getMangaImageUrl(
        'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx30013.jpg'
      ),
      '/imageproxy/anilist/file/anilistcdn/media/manga/cover/large/bx30013.jpg'
    );
    assert.equal(
      getMangaImageUrl('https://s4.anilist.co/file/banner.jpg?v=2'),
      '/imageproxy/anilist/file/banner.jpg?v=2'
    );
  });

  it('drops every other image source', () => {
    for (const imageUrl of [
      undefined,
      '',
      'not a url',
      '/imageproxy/anilist/file/cover.jpg',
      'http://s4.anilist.co/file/cover.jpg',
      'https://s4.anilist.co.example.com/file/cover.jpg',
      'https://evil.example/s4.anilist.co/file/cover.jpg',
      'https://example.com/https://s4.anilist.co/file/cover.jpg',
      'https://s4.anilist.co@example.com/file/cover.jpg',
      'https://user@s4.anilist.co/file/cover.jpg',
      'https://user:secret@s4.anilist.co/file/cover.jpg',
      'https://s4.anilist.co:8443/file/cover.jpg',
      'https://img.anilist.co/file/cover.jpg',
      'javascript:alert(1)',
    ]) {
      assert.equal(getMangaImageUrl(imageUrl), undefined, String(imageUrl));
    }
  });
});

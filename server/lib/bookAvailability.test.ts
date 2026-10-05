import { MediaStatus, MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasAvailableBookFormat,
  isRequestedBookFormatAvailable,
} from './bookAvailability';

const bookMedia = (overrides: Partial<Media> = {}) =>
  new Media({
    mediaType: MediaType.BOOK,
    tmdbId: 0,
    status: MediaStatus.AVAILABLE,
    status4k: MediaStatus.UNKNOWN,
    ...overrides,
  });

test('book availability follows the selected format', () => {
  const ebookOnly = bookMedia({ serviceId: 1, externalServiceId: 10 });

  assert.equal(hasAvailableBookFormat(ebookOnly, 'ebook'), true);
  assert.equal(hasAvailableBookFormat(ebookOnly, 'audiobook'), false);
  assert.equal(isRequestedBookFormatAvailable(ebookOnly, 'ebook'), true);
  assert.equal(isRequestedBookFormatAvailable(ebookOnly, 'audiobook'), false);
  assert.equal(isRequestedBookFormatAvailable(ebookOnly, 'both'), false);

  const both = bookMedia({
    serviceId: 1,
    externalServiceId: 10,
    audiobookServiceId: 2,
    audiobookExternalServiceId: 20,
  });
  assert.equal(isRequestedBookFormatAvailable(both, 'both'), true);
});

test('a service link alone does not make a processing book available', () => {
  const processing = bookMedia({
    status: MediaStatus.PROCESSING,
    serviceId: 1,
    externalServiceId: 10,
    audiobookServiceId: 2,
    audiobookExternalServiceId: 20,
  });

  assert.equal(isRequestedBookFormatAvailable(processing, 'ebook'), false);
  assert.equal(isRequestedBookFormatAvailable(processing, 'audiobook'), false);
  assert.equal(isRequestedBookFormatAvailable(processing, 'both'), false);
});

test('Audiobookshelf library presence satisfies audiobook requests only', () => {
  const audiobookOnly = bookMedia({
    audiobookLibraryServiceId: 1,
    audiobookLibraryItemId: 'li_audiobook_1',
  });

  assert.equal(hasAvailableBookFormat(audiobookOnly, 'audiobook'), true);
  assert.equal(hasAvailableBookFormat(audiobookOnly, 'ebook'), false);
  assert.equal(isRequestedBookFormatAvailable(audiobookOnly, 'both'), false);
});

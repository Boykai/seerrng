import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAvailableIssueQualities,
  getIssueMediaAndFormatLabel,
} from '@app/components/IssueDetails/issueMediaFormat';
import { MediaStatus, MediaType } from '@server/constants/media';

test('issue media labels include the saved movie and series quality', () => {
  assert.equal(
    getIssueMediaAndFormatLabel(MediaType.MOVIE, false),
    'Movie · HD'
  );
  assert.equal(
    getIssueMediaAndFormatLabel(MediaType.MOVIE, true),
    'Movie · 4K'
  );
  assert.equal(getIssueMediaAndFormatLabel(MediaType.TV, false), 'Series · HD');
  assert.equal(getIssueMediaAndFormatLabel(MediaType.TV, true), 'Series · 4K');
  assert.equal(
    getIssueMediaAndFormatLabel(MediaType.MUSIC, false),
    'Music · Album'
  );
  assert.equal(getIssueMediaAndFormatLabel(MediaType.BOOK, false), 'Book');
  assert.equal(getIssueMediaAndFormatLabel(MediaType.MANGA, false), 'Manga');
  assert.equal(getIssueMediaAndFormatLabel(MediaType.MANGA, true), 'Manga');
});

test('issue quality choices include only qualities currently available', () => {
  assert.deepEqual(
    getAvailableIssueQualities({
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
    }),
    ['hd']
  );
  assert.deepEqual(
    getAvailableIssueQualities({
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.AVAILABLE,
    }),
    ['4k']
  );
  assert.deepEqual(
    getAvailableIssueQualities({
      status: MediaStatus.PARTIALLY_AVAILABLE,
      status4k: MediaStatus.AVAILABLE,
    }),
    ['hd', '4k']
  );
  assert.deepEqual(
    getAvailableIssueQualities({
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
    }),
    []
  );
});

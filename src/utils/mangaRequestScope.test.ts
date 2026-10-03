import assert from 'node:assert/strict';
import test from 'node:test';

import { MangaRequestScope } from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import {
  MAX_MANGA_CHAPTER_NUMBER,
  MAX_MANGA_LATEST_COUNT,
  parseMangaRequestScope,
} from '@server/lib/mangaRequests';
import {
  MANGA_MAX_CHAPTER_NUMBER,
  MANGA_MAX_LATEST_COUNT,
  draftFromMangaScope,
  getMangaAniListId,
  isAwaitingMangaSource,
  parseMangaScopeDraft,
  type MangaScopeDraft,
} from './mangaRequestScope';

const draft = (fields: Partial<MangaScopeDraft>): MangaScopeDraft => ({
  scope: MangaRequestScope.ALL_AT_DISPATCH,
  latestCount: '',
  rangeStart: '',
  rangeEnd: '',
  ...fields,
});

const latest = (latestCount: string) =>
  parseMangaScopeDraft(
    draft({ scope: MangaRequestScope.LATEST_N, latestCount })
  );

const range = (rangeStart: string, rangeEnd = '') =>
  parseMangaScopeDraft(
    draft({ scope: MangaRequestScope.RANGE, rangeStart, rangeEnd })
  );

test('client limits equal the server limits', () => {
  assert.equal(MANGA_MAX_LATEST_COUNT, MAX_MANGA_LATEST_COUNT);
  assert.equal(MANGA_MAX_CHAPTER_NUMBER, MAX_MANGA_CHAPTER_NUMBER);
  assert.equal(MANGA_MAX_LATEST_COUNT, 10_000);
  assert.equal(MANGA_MAX_CHAPTER_NUMBER, 1_000_000);
});

test('every chapter sends the scope alone', () => {
  assert.deepEqual(parseMangaScopeDraft(draft({ latestCount: '5' })), {
    body: { scope: MangaRequestScope.ALL_AT_DISPATCH },
    errors: {},
  });
});

test('latest chapters accept whole numbers from 1 to 10,000', () => {
  assert.deepEqual(latest('1').body, {
    scope: MangaRequestScope.LATEST_N,
    latestCount: 1,
  });
  assert.deepEqual(latest(' 10000 ').body, {
    scope: MangaRequestScope.LATEST_N,
    latestCount: 10_000,
  });
  for (const refused of ['0', '10001', '1.5', '-1', '', '1e3', 'abc']) {
    assert.deepEqual(latest(refused), { errors: { latestCount: 'invalid' } });
  }
});

test('ranges accept zero, decimals and an open end', () => {
  assert.deepEqual(range('0').body, {
    scope: MangaRequestScope.RANGE,
    rangeStart: 0,
  });
  assert.deepEqual(range('10.5', '20').body, {
    scope: MangaRequestScope.RANGE,
    rangeStart: 10.5,
    rangeEnd: 20,
  });
  assert.deepEqual(range('7', '7').body, {
    scope: MangaRequestScope.RANGE,
    rangeStart: 7,
    rangeEnd: 7,
  });
  assert.deepEqual(range('.5').body, {
    scope: MangaRequestScope.RANGE,
    rangeStart: 0.5,
  });
});

test('ranges refuse a bad start, a bad end and an end before the start', () => {
  assert.deepEqual(range(''), { errors: { rangeStart: 'invalid' } });
  assert.deepEqual(range('1000001'), { errors: { rangeStart: 'invalid' } });
  assert.deepEqual(range('-1'), { errors: { rangeStart: 'invalid' } });
  assert.deepEqual(range('10', '9.5'), {
    errors: { rangeEnd: 'beforeStart' },
  });
  assert.deepEqual(range('10', '1000001'), {
    errors: { rangeEnd: 'invalid' },
  });
  assert.deepEqual(range('x', 'y'), {
    errors: { rangeStart: 'invalid', rangeEnd: 'invalid' },
  });
});

test('the server accepts every body the client builds', () => {
  for (const result of [
    parseMangaScopeDraft(draft({})),
    latest('1'),
    latest('10000'),
    range('0'),
    range('10.5', '20'),
    range('1000000', '1000000'),
  ]) {
    assert.ok(result.body);
    assert.ok('value' in parseMangaRequestScope(result.body));
  }
});

test('the server refuses the numbers the client refuses', () => {
  for (const latestCount of [0, 10_001]) {
    assert.ok(
      'error' in
        parseMangaRequestScope({
          scope: MangaRequestScope.LATEST_N,
          latestCount,
        })
    );
  }
  assert.ok(
    'error' in
      parseMangaRequestScope({
        scope: MangaRequestScope.RANGE,
        rangeStart: 10,
        rangeEnd: 9.5,
      })
  );
});

test('a stored scope fills the form', () => {
  assert.deepEqual(draftFromMangaScope(undefined), draft({}));
  assert.deepEqual(
    draftFromMangaScope({
      scope: MangaRequestScope.RANGE,
      latestCount: null,
      rangeStart: 10.5,
      rangeEnd: null,
    }),
    draft({ scope: MangaRequestScope.RANGE, rangeStart: '10.5' })
  );
  assert.deepEqual(
    draftFromMangaScope({
      scope: MangaRequestScope.LATEST_N,
      latestCount: 25,
      rangeStart: null,
      rangeEnd: null,
    }),
    draft({ scope: MangaRequestScope.LATEST_N, latestCount: '25' })
  );
});

test('only an approved manga request with awaitingBinding waits for a source', () => {
  const mangaScope = {
    scope: MangaRequestScope.ALL_AT_DISPATCH,
    latestCount: null,
    rangeStart: null,
    rangeEnd: null,
    awaitingBinding: true,
  };
  assert.equal(
    isAwaitingMangaSource({
      type: MediaType.MANGA,
      status: MediaRequestStatus.APPROVED,
      mangaScope,
    }),
    true
  );
  for (const request of [
    {
      type: MediaType.MANGA,
      status: MediaRequestStatus.PENDING,
      mangaScope,
    },
    {
      type: MediaType.MANGA,
      status: MediaRequestStatus.APPROVED,
      mangaScope: { ...mangaScope, awaitingBinding: false },
    },
    { type: MediaType.MANGA, status: MediaRequestStatus.APPROVED },
    {
      type: MediaType.COMIC,
      status: MediaRequestStatus.APPROVED,
      mangaScope,
    },
  ]) {
    assert.equal(isAwaitingMangaSource(request), false);
  }
});

test('the AniList ID comes from the anilist identifier only', () => {
  const media = (provider: string, value: string) =>
    ({ identifiers: [{ provider, value }] }) as unknown as Parameters<
      typeof getMangaAniListId
    >[0];
  assert.equal(getMangaAniListId(media('anilist', '30013')), 30013);
  assert.equal(getMangaAniListId(media('tmdb', '30013')), undefined);
  assert.equal(getMangaAniListId(media('anilist', '0')), undefined);
  assert.equal(getMangaAniListId(media('anilist', '12a')), undefined);
  assert.equal(getMangaAniListId(undefined), undefined);
});

import {
  ANILIST_MANGA_COUNTRIES,
  ANILIST_MANGA_FORMATS,
  ANILIST_MANGA_SOURCES,
  ANILIST_MANGA_STATUSES,
} from '@server/api/anilist/manga';
import { MAX_MANGA_FILTER_NAMES as SERVER_MAX_NAMES } from '@server/lib/mangaDiscoverFilters';
import { expect, it } from 'vitest';
import {
  clearedMangaFilters,
  getMangaFilterParams,
  joinMangaFilterNames,
  MANGA_COUNTRIES,
  MANGA_FILTER_KEYS,
  MANGA_FORMATS,
  MANGA_SOURCES,
  MANGA_STATUSES,
  MAX_MANGA_FILTER_NAMES,
  splitMangaFilterNames,
} from './mangaFilterParams';

it('offers the values the discover API accepts', () => {
  expect([...MANGA_FORMATS].sort()).toEqual([...ANILIST_MANGA_FORMATS].sort());
  expect([...MANGA_STATUSES].sort()).toEqual(
    [...ANILIST_MANGA_STATUSES].sort()
  );
  expect([...MANGA_COUNTRIES].sort()).toEqual(
    [...ANILIST_MANGA_COUNTRIES].sort()
  );
  expect([...MANGA_SOURCES].sort()).toEqual([...ANILIST_MANGA_SOURCES].sort());
  expect(MAX_MANGA_FILTER_NAMES).toBe(SERVER_MAX_NAMES);
});

it('splits, trims and de-duplicates name lists', () => {
  expect(splitMangaFilterNames(' Action, Drama ,,Action ')).toEqual([
    'Action',
    'Drama',
  ]);
  expect(splitMangaFilterNames(undefined)).toEqual([]);
  expect(joinMangaFilterNames(['Action', 'Drama'])).toBe('Action,Drama');
  expect(joinMangaFilterNames([])).toBeUndefined();
});

it('reads only filters the controls can show from the address', () => {
  expect(
    getMangaFilterParams({
      format: 'ONE_SHOT',
      status: 'finished',
      countryOfOrigin: ['JP', 'KR'],
      source: 'WEB_NOVEL',
      genres: ' Action,,Action ',
      excludeTags: ' , ',
      minStartYear: '1999',
      maxStartYear: '2000.5',
      minScore: '-10',
      maxChapters: '1234567',
      minVolumes: '0',
      genre: 'Drama',
      query: 'title',
    })
  ).toEqual({
    format: 'ONE_SHOT',
    source: 'WEB_NOVEL',
    genres: 'Action',
    minStartYear: '1999',
    minVolumes: '0',
  });
});

it('clears every filter key', () => {
  expect(Object.keys(clearedMangaFilters)).toEqual([...MANGA_FILTER_KEYS]);
  expect(Object.values(clearedMangaFilters)).toEqual(
    MANGA_FILTER_KEYS.map(() => undefined)
  );
});

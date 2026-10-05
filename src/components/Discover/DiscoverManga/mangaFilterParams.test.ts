import {
  ANILIST_MANGA_COUNTRIES,
  ANILIST_MANGA_FORMATS,
  ANILIST_MANGA_SOURCES,
  ANILIST_MANGA_STATUSES,
  MAX_ANILIST_FILTER_NAME_LENGTH,
} from '@server/api/anilist/manga';
import {
  parseMangaDiscoverFilters,
  MAX_MANGA_FILTER_NAMES as SERVER_MAX_NAMES,
} from '@server/lib/mangaDiscoverFilters';
import { expect, it } from 'vitest';
import {
  clearedMangaFilters,
  getMangaFilterHref,
  getMangaFilterParams,
  joinMangaFilterNames,
  MANGA_COUNTRIES,
  MANGA_FILTER_KEYS,
  MANGA_FORMATS,
  MANGA_SOURCES,
  MANGA_STATUSES,
  MAX_MANGA_FILTER_NAME_LENGTH,
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
  expect(MAX_MANGA_FILTER_NAME_LENGTH).toBe(MAX_ANILIST_FILTER_NAME_LENGTH);
});

it.each([
  ['genres', 'Slice of Life', '/discover/manga?genres=Slice%20of%20Life'],
  ['genres', "Boys' Love", "/discover/manga?genres=Boys'%20Love"],
  ['tags', 'Cats & Dogs', '/discover/manga?tags=Cats%20%26%20Dogs'],
  ['tags', 'Before/After', '/discover/manga?tags=Before%2FAfter'],
  ['tags', 'A+B 100% #1', '/discover/manga?tags=A%2BB%20100%25%20%231'],
  ['tags', 'Café', '/discover/manga?tags=Caf%C3%A9'],
  ['tags', 'x'.repeat(64), `/discover/manga?tags=${'x'.repeat(64)}`],
] as const)(
  'links the %s name %j to a filter the page and the API read back unchanged',
  (filter, name, expected) => {
    const href = getMangaFilterHref(filter, name);
    expect(href).toBe(expected);

    const url = new URL(href!, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    expect(url.pathname).toBe('/discover/manga');
    expect(getMangaFilterParams(query)).toEqual({ [filter]: name });
    expect(parseMangaDiscoverFilters(query, undefined)).toEqual({
      value: { [filter]: [name] },
    });
  }
);

it.each(['', ' Drama', 'Drama ', 'Comedy, Drama', 'x'.repeat(65)])(
  'gives no filter address to the name %j, which the list cannot carry',
  (name) => {
    expect(getMangaFilterHref('genres', name)).toBeUndefined();
    expect(getMangaFilterHref('tags', name)).toBeUndefined();
  }
);

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

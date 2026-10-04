import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_MANGA_FILTER_LIST_LENGTH,
  parseMangaDiscoverFilters,
} from '@server/lib/mangaDiscoverFilters';

const parse = (query: Record<string, unknown>, genre?: string) =>
  parseMangaDiscoverFilters(query, genre);

const nameListError = (field: string) =>
  `${field} must list 1 to 10 names of up to 64 characters, separated by commas.`;

describe('parseMangaDiscoverFilters', () => {
  it('returns no filters when none are set', () => {
    assert.deepStrictEqual(parse({}), { value: {} });
    assert.deepStrictEqual(
      parse({ genres: '', source: '', minScore: '', page: '2' }),
      { value: {} }
    );
  });

  it('reads every filter and keeps only the ones that are set', () => {
    assert.deepStrictEqual(
      parse({
        genres: 'Action, Drama ,Action',
        excludeGenres: 'Horror',
        tags: 'Pirates',
        excludeTags: 'Time Skip,Isekai',
        source: 'WEB_NOVEL',
        minStartYear: '1990',
        maxStartYear: 2005,
        minScore: '70',
        maxChapters: '200',
        minVolumes: 0,
      }),
      {
        value: {
          genres: ['Action', 'Drama'],
          excludedGenres: ['Horror'],
          tags: ['Pirates'],
          excludedTags: ['Time Skip', 'Isekai'],
          source: 'WEB_NOVEL',
          startYear: { min: 1990, max: 2005 },
          averageScore: { min: 70 },
          chapters: { max: 200 },
          volumes: { min: 0 },
        },
      }
    );
  });

  it('bounds name lists', () => {
    const elevenNames = Array.from({ length: 11 }, (_, i) => `Tag ${i}`);
    for (const [field, value] of [
      ['genres', elevenNames.join(',')],
      ['excludeGenres', 'g'.repeat(65)],
      ['tags', 'Pirates,,Isekai'],
      ['excludeTags', ' '],
      ['tags', ['Pirates', 'Isekai']],
      ['genres', 'g'.repeat(MAX_MANGA_FILTER_LIST_LENGTH + 1)],
    ] as const) {
      assert.deepStrictEqual(
        parse({ [field]: value }),
        { error: nameListError(field) },
        `${field}=${String(value)}`
      );
    }

    const tenLongNames = Array.from({ length: 10 }, (_, i) =>
      `${i}`.padEnd(64, 'n')
    ).join(',');
    assert.equal(tenLongNames.length, MAX_MANGA_FILTER_LIST_LENGTH);
    const parsed = parse({ genres: tenLongNames });
    assert.ok('value' in parsed);
    assert.equal(parsed.value.genres?.length, 10);
  });

  it('accepts only AniList source values', () => {
    assert.deepStrictEqual(parse({ source: 'BOOK' }), {
      error: 'source must be valid.',
    });
    assert.deepStrictEqual(parse({ source: 'light_novel' }), {
      error: 'source must be valid.',
    });
  });

  it('bounds every range and keeps its ends in order', () => {
    for (const [query, error] of [
      [
        { minStartYear: '1799' },
        'minStartYear must be a whole number from 1800 to 2200.',
      ],
      [
        { maxStartYear: '2201' },
        'maxStartYear must be a whole number from 1800 to 2200.',
      ],
      [{ minScore: '-1' }, 'minScore must be a whole number from 0 to 100.'],
      [{ maxScore: 101 }, 'maxScore must be a whole number from 0 to 100.'],
      [
        { minChapters: '1.5' },
        'minChapters must be a whole number from 0 to 100000.',
      ],
      [
        { maxVolumes: '100001' },
        'maxVolumes must be a whole number from 0 to 100000.',
      ],
      [
        { minVolumes: '1e3' },
        'minVolumes must be a whole number from 0 to 100000.',
      ],
      [
        { maxChapters: ['1', '2'] },
        'maxChapters must be a whole number from 0 to 100000.',
      ],
      [
        { minScore: '80', maxScore: '60' },
        'minScore must not be greater than maxScore.',
      ],
      [
        { minStartYear: 2010, maxStartYear: 2000 },
        'minStartYear must not be greater than maxStartYear.',
      ],
    ] as const) {
      assert.deepStrictEqual(parse(query), { error }, JSON.stringify(query));
    }

    assert.deepStrictEqual(parse({ minChapters: '5', maxChapters: '5' }), {
      value: { chapters: { min: 5, max: 5 } },
    });
  });

  it('refuses a name that is both included and excluded', () => {
    assert.deepStrictEqual(
      parse({ genres: 'Action,Drama', excludeGenres: 'Drama' }),
      { error: 'genres and excludeGenres must not share a name.' }
    );
    assert.deepStrictEqual(parse({ excludeGenres: 'Drama' }, 'Drama'), {
      error: 'genres and excludeGenres must not share a name.',
    });
    assert.deepStrictEqual(
      parse({ tags: 'Pirates', excludeTags: 'Isekai, Pirates' }),
      { error: 'tags and excludeTags must not share a name.' }
    );
    assert.deepStrictEqual(parse({ excludeGenres: 'Drama' }, 'Action'), {
      value: { excludedGenres: ['Drama'] },
    });
  });
});

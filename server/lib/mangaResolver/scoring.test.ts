import { MangaBindingConfidence } from '@server/entity/MangaSourceBinding';
import {
  MANGA_RESOLVER_AUTHOR_BONUS,
  MANGA_RESOLVER_QUERY_MAX_LENGTH,
  languageRank,
  mangaResolverProfile,
  mangadexQueries,
  rateSourceMatch,
  scoreSourceManga,
  sourceQueries,
  type MangaResolverTitle,
} from '@server/lib/mangaResolver/scoring';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { HIGH, MEDIUM, LOW } = MangaBindingConfidence;

const title = (
  overrides: Partial<MangaResolverTitle> = {}
): MangaResolverTitle => ({
  titles: {
    english: 'Invented Harbor Tale',
    romaji: 'Tsukurareta Minato',
    native: '作られた港',
  },
  synonyms: [],
  format: 'MANGA',
  countryOfOrigin: 'JP',
  staff: [],
  ...overrides,
});

describe('manga resolver queries', () => {
  it('asks MangaDex for English, romaji, then native, without repeats', () => {
    assert.deepEqual(mangadexQueries(title(), 3), [
      'Invented Harbor Tale',
      'Tsukurareta Minato',
      '作られた港',
    ]);
    assert.deepEqual(mangadexQueries(title(), 2), [
      'Invented Harbor Tale',
      'Tsukurareta Minato',
    ]);
    // Titles that compare equal, blanks and bracketed notes collapse.
    assert.deepEqual(
      mangadexQueries(
        title({
          titles: {
            english: 'Invented  Tale (Official)',
            romaji: 'INVENTED TALE',
            native: '   ',
          },
        }),
        3
      ),
      ['Invented Tale']
    );
    assert.deepEqual(mangadexQueries(title({ titles: {} }), 3), []);
  });

  it('cuts a query to the limit without splitting a character', () => {
    const native = `a${'𠀀'.repeat(127)}`;
    const [query] = mangadexQueries(title({ titles: { native } }), 1);
    assert.ok(query.length <= MANGA_RESOLVER_QUERY_MAX_LENGTH);
    assert.equal(query.length, 199);
    assert.ok(!/[\uD800-\uDBFF]$/.test(query));
  });

  it('puts the native title first for a source in the original language', () => {
    assert.deepEqual(sourceQueries(title(), 'ja', 2), [
      '作られた港',
      'Tsukurareta Minato',
    ]);
    assert.deepEqual(sourceQueries(title(), 'JA-jp', 1), ['作られた港']);
    assert.deepEqual(sourceQueries(title(), 'en', 2), [
      'Invented Harbor Tale',
      'Tsukurareta Minato',
    ]);
    assert.deepEqual(sourceQueries(title({ countryOfOrigin: 'KR' }), 'ja', 1), [
      'Invented Harbor Tale',
    ]);
    assert.deepEqual(
      sourceQueries(title({ countryOfOrigin: undefined }), 'ja', 1),
      ['Invented Harbor Tale']
    );
  });
});

describe('manga resolver language rank', () => {
  it('ranks every source equal without preferred languages', () => {
    assert.equal(languageRank('en', []), 0);
    assert.equal(languageRank('', []), 0);
  });

  it('ranks by preference, then multi-language sources, else not at all', () => {
    const preferred = ['en', 'pt-BR'];
    assert.equal(languageRank('en', preferred), 0);
    assert.equal(languageRank('PT-br', preferred), 1);
    assert.equal(languageRank('all', preferred), 2);
    assert.equal(languageRank('Multi', preferred), 2);
    assert.equal(languageRank('pt', preferred), undefined);
    assert.equal(languageRank('', preferred), undefined);
  });
});

describe('manga resolver scoring', () => {
  it('keeps normalized titles and synonyms, and only story or art staff', () => {
    const profile = mangaResolverProfile(
      title({
        synonyms: [
          'Invented Harbor Tale!',
          ...Array.from({ length: 25 }, (_, i) => `Alias ${i}`),
        ],
        staff: [
          { id: 1, name: 'Ada Inventa', role: 'Story & Art' },
          { id: 2, name: 'Ben Fictive', role: 'Art' },
          { id: 3, name: 'Cy Letterer', role: 'Lettering' },
          { id: 4, name: 'Di Editor', role: 'Original Story' },
          { id: 5, name: 'Ada Inventa', role: 'Story' },
        ],
      })
    );
    assert.deepEqual(profile.titles.slice(0, 3), [
      'tsukurareta minato',
      'invented harbor tale',
      '作られた港',
    ]);
    // The duplicate synonym is gone and only the first 20 synonyms count.
    assert.equal(profile.titles.length, 3 + 19);
    assert.deepEqual(profile.authors, [
      'ada inventa',
      'ben fictive',
      'di editor',
    ]);
    assert.equal(profile.capped, false);
    assert.equal(
      mangaResolverProfile(title({ format: 'ONE_SHOT' })).capped,
      true
    );
    assert.equal(mangaResolverProfile(title({ format: 'NOVEL' })).capped, true);
  });

  it('scores the best title and adds the author bonus once', () => {
    const profile = mangaResolverProfile(
      title({ staff: [{ id: 1, name: 'Ada Inventa', role: 'Story' }] })
    );
    assert.equal(
      scoreSourceManga(profile, { title: 'Invented Harbor Tale' }),
      1000
    );
    assert.equal(
      scoreSourceManga(profile, {
        title: 'invented harbor tale',
        author: 'Ada Inventa',
      }),
      1000
    );
    const plain = scoreSourceManga(profile, {
      title: 'Invented Harbour Tales',
    });
    assert.ok(plain > 800 && plain < 1000);
    assert.equal(
      scoreSourceManga(profile, {
        title: 'Invented Harbour Tales',
        author: 'Someone Else; ADA INVENTA',
      }),
      Math.min(1000, plain + MANGA_RESOLVER_AUTHOR_BONUS)
    );
    assert.equal(
      scoreSourceManga(profile, {
        title: 'Invented Harbour Tales',
        author: 'Cy Letterer',
      }),
      plain
    );
    assert.equal(scoreSourceManga(profile, { title: '!!!' }), 0);
  });

  it('rates a source match by score, lead and format', () => {
    assert.equal(rateSourceMatch(499, 0, false), undefined);
    assert.equal(rateSourceMatch(500, 0, false), LOW);
    assert.equal(rateSourceMatch(749, 0, false), LOW);
    assert.equal(rateSourceMatch(750, 0, false), MEDIUM);
    assert.equal(rateSourceMatch(920, 870, false), HIGH);
    assert.equal(rateSourceMatch(920, 871, false), MEDIUM);
    assert.equal(rateSourceMatch(1000, 0, true), MEDIUM);
  });
});

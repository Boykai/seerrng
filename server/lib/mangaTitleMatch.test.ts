import { MangaBindingConfidence } from '@server/entity/MangaSourceBinding';
import type { MangaTitleCandidate } from '@server/lib/mangaTitleMatch';
import {
  mangaTitleSearchText,
  mangaTitleSimilarity,
  normalizeMangaTitle,
  proposeMangaMatch,
} from '@server/lib/mangaTitleMatch';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { HIGH, MEDIUM, LOW } = MangaBindingConfidence;

const result = (
  id: number,
  romaji: string,
  extra: Partial<MangaTitleCandidate> = {}
): MangaTitleCandidate => ({
  id,
  titles: { romaji },
  synonyms: [],
  ...extra,
});

describe('normalizeMangaTitle', () => {
  const cases: [string, string, string][] = [
    ['Latin diacritics', 'Café Délicieux', 'cafe delicieux'],
    ['dotted capital I', 'İnvented', 'invented'],
    [
      'full-width Latin and ideographic space',
      'ＦＵＬＬ　ＷＩＤＴＨ',
      'full width',
    ],
    ['kana voicing marks', 'がっこう', 'がっこう'],
    ['half-width katakana', 'ｶﾞｯｺｳ', 'ガッコウ'],
    ['other scripts keep their marks', 'มังงะ', 'มังงะ'],
    [
      'bracketed notes',
      'Invented Tale (Official) [Color] {Remastered} 【Digital】',
      'invented tale',
    ],
    ['nested brackets', 'Nested (Part (Two))', 'nested'],
    ['only brackets', '(Only Brackets)', 'only brackets'],
    ['punctuation', 'Hello, World! -- Again?', 'hello world again'],
    ['compatibility digits', 'Ｖｏｌ．１２', 'vol 12'],
    ['nothing comparable', '!!!', ''],
    ['the length cap', 'a'.repeat(200), 'a'.repeat(128)],
    ['the cap counts code points', '𠀀'.repeat(130), '𠀀'.repeat(128)],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => assert.equal(normalizeMangaTitle(input), expected));
  }
});

describe('mangaTitleSearchText', () => {
  const cases: [string, string][] = [
    ['  Invented   Tale (Official)  ', 'Invented Tale'],
    ['Café [Color]', 'Café'],
    ['(Only Brackets)', '(Only Brackets)'],
    ['b'.repeat(200), 'b'.repeat(128)],
  ];
  for (const [input, expected] of cases) {
    it(`searches ${JSON.stringify(input.slice(0, 20))}`, () =>
      assert.equal(mangaTitleSearchText(input), expected));
  }
});

describe('mangaTitleSimilarity', () => {
  const cases: [string, string, number][] = [
    ['invented tale', 'invented tale', 1],
    ['', 'invented tale', 0],
    ['invented tale', '', 0],
    ['invented tale', 'tale invented', 1],
    ['abcd', 'abce', 0.75],
    ['kitten', 'sitting', 1 - 3 / 7],
  ];
  for (const [a, b, expected] of cases) {
    it(`${JSON.stringify(a)} and ${JSON.stringify(b)}`, () =>
      assert.ok(Math.abs(mangaTitleSimilarity(a, b) - expected) < 1e-9));
  }
});

describe('proposeMangaMatch', () => {
  const none = new Set<number>();
  const cases: [
    string,
    string,
    MangaTitleCandidate[],
    Set<number>,
    ReturnType<typeof proposeMangaMatch>,
  ][] = [
    [
      'HIGH for a clear exact match',
      'The Invented Tale',
      [result(101, 'The Invented Tale'), result(102, 'Another Story')],
      none,
      { anilistId: 101, confidence: HIGH, score: 1000 },
    ],
    [
      'HIGH at exactly 0.92',
      'abcdefghijklmnopqrstuvwxy',
      [result(103, 'abcdefghijklmnopqrstuvw')],
      none,
      { anilistId: 103, confidence: HIGH, score: 920 },
    ],
    [
      'MEDIUM just below 0.92',
      'abcdefghijklmnopqrstuvwx',
      [result(104, 'abcdefghijklmnopqrstuv')],
      none,
      { anilistId: 104, confidence: MEDIUM, score: 917 },
    ],
    [
      'MEDIUM by score',
      'Invented Tale II',
      [result(105, 'Invented Tale')],
      none,
      { anilistId: 105, confidence: MEDIUM, score: 813 },
    ],
    [
      'MEDIUM for a near tie at the top',
      'The Invented Tale of Nothing',
      [
        result(106, 'The Invented Tale of Nothing'),
        result(107, 'The Invented Tale of Nothin'),
      ],
      none,
      { anilistId: 106, confidence: MEDIUM, score: 1000 },
    ],
    [
      'HIGH when the lead is exactly the margin',
      'abcdefghijklmnopqrst',
      [
        result(108, 'abcdefghijklmnopqrst'),
        result(109, 'abcdefghijklmnopqrsx'),
      ],
      none,
      { anilistId: 108, confidence: HIGH, score: 1000 },
    ],
    [
      'MEDIUM at exactly 0.75',
      'abcd',
      [result(110, 'abce')],
      none,
      { anilistId: 110, confidence: MEDIUM, score: 750 },
    ],
    [
      'LOW keeps the best weak guess',
      'abcdefg',
      [result(111, 'abcdexy'), result(112, 'zzzzzzz')],
      none,
      { anilistId: 111, confidence: LOW, score: 714 },
    ],
    ['no proposal without results', 'The Invented Tale', [], none, null],
    [
      'no proposal when every result is rejected',
      'The Invented Tale',
      [result(113, 'The Invented Tale')],
      new Set([113]),
      null,
    ],
    [
      'a rejected pair gives way to the next best',
      'The Invented Tale',
      [result(114, 'The Invented Tale'), result(115, 'The Invented Tales')],
      new Set([114]),
      { anilistId: 115, confidence: HIGH, score: 944 },
    ],
    [
      'a native title can match',
      'ｶﾞｯｺｳ',
      [
        result(116, 'Foreign Name', {
          titles: { romaji: 'Foreign Name', english: 'School' },
          synonyms: ['Another Name'],
        }),
        result(117, 'Gakkou', { titles: { native: 'ガッコウ' } }),
      ],
      none,
      { anilistId: 117, confidence: HIGH, score: 1000 },
    ],
    [
      'an English title can match',
      'School Days',
      [
        result(125, 'Gakuen', {
          titles: { romaji: 'Gakuen', english: 'School Days' },
        }),
      ],
      none,
      { anilistId: 125, confidence: HIGH, score: 1000 },
    ],
    [
      'a synonym can match',
      'The Invented Tale',
      [result(118, 'Foreign Name', { synonyms: ['The Invented Tale'] })],
      none,
      { anilistId: 118, confidence: HIGH, score: 1000 },
    ],
    [
      'synonyms after the twentieth are ignored',
      'qqqq',
      [
        result(119, 'zzzz', {
          synonyms: [...Array<string>(20).fill('zzzz'), 'qqqq'],
        }),
      ],
      none,
      { anilistId: 119, confidence: LOW, score: 0 },
    ],
    [
      'titles are compared on their first 128 code points',
      `${'a'.repeat(128)}b`,
      [result(120, `${'a'.repeat(128)}c`)],
      none,
      { anilistId: 120, confidence: HIGH, score: 1000 },
    ],
    [
      'equal scores go to the better search rank',
      'The Invented Tale',
      [result(122, 'The Invented Tale!'), result(121, 'The Invented Tale')],
      none,
      { anilistId: 122, confidence: MEDIUM, score: 1000 },
    ],
    [
      'a repeated result counts once',
      'The Invented Tale',
      [result(123, 'The Invented Tale'), result(123, 'The Invented Tale')],
      none,
      { anilistId: 123, confidence: HIGH, score: 1000 },
    ],
    [
      'no proposal for a title with nothing comparable',
      '!!!',
      [result(124, 'The Invented Tale')],
      none,
      null,
    ],
  ];
  for (const [name, title, results, rejected, expected] of cases) {
    it(name, () =>
      assert.deepEqual(proposeMangaMatch(title, results, rejected), expected)
    );
  }
});

import { MediaStatus } from '@server/constants/media';
import {
  computeMangaAvailability,
  needsMangaChapterStates,
  type MangaAvailability,
  type MangaAvailabilityInput,
  type MangaChapterState,
} from '@server/lib/mangaAvailability';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AVAILABLE, PARTIALLY_AVAILABLE: PARTIAL } = MediaStatus;

/** `[chapterNumber, isDownloaded]` pairs to chapter states. */
const states = (...rows: [number, boolean][]): MangaChapterState[] =>
  rows.map(([chapterNumber, isDownloaded]) => ({
    chapterNumber,
    isDownloaded,
  }));

const input = (
  chapterCount: number,
  downloadCount: number,
  hasDuplicateChapters: boolean,
  chapterStates?: readonly MangaChapterState[]
): MangaAvailabilityInput => ({
  chapterCount,
  downloadCount,
  hasDuplicateChapters,
  chapterStates,
});

describe('computeMangaAvailability', () => {
  it('applies every rule in order', () => {
    const cases: [string, MangaAvailabilityInput, MangaAvailability][] = [
      ['no chapters', input(0, 0, false), 'none'],
      ['no chapters, stale download count', input(0, 3, true), 'none'],
      ['no downloads', input(5, 0, false), 'none'],
      ['no downloads, duplicates', input(5, 0, true), 'none'],
      ['every chapter downloaded', input(5, 5, false), AVAILABLE],
      ['more downloads than chapters', input(3, 5, false), AVAILABLE],
      [
        'more downloads than chapters, duplicates',
        input(3, 4, true),
        AVAILABLE,
      ],
      ['partial without duplicates', input(5, 2, false), PARTIAL],
      [
        'partial without duplicates ignores states',
        input(3, 1, false, states([1, true], [1, true], [2, false])),
        PARTIAL,
      ],
      [
        'duplicates, every number downloaded',
        input(3, 2, true, states([1, true], [1, false], [2, true])),
        AVAILABLE,
      ],
      [
        'duplicates, a number missing',
        input(3, 2, true, states([1, true], [1, true], [2, false])),
        PARTIAL,
      ],
      [
        'duplicates, fractional numbers are units',
        input(3, 2, true, states([1, true], [1.5, false], [1, true])),
        PARTIAL,
      ],
      [
        'only unnumbered chapters, one missing',
        input(2, 1, true, states([-1, true], [-1, false])),
        PARTIAL,
      ],
      [
        'mixed, unnumbered and numbered all downloaded',
        input(3, 2, true, states([1, true], [1, false], [-1, true])),
        AVAILABLE,
      ],
      [
        'mixed, an unnumbered chapter missing',
        input(3, 1, true, states([1, true], [1, false], [-1, false])),
        PARTIAL,
      ],
      [
        'mixed, a numbered unit missing',
        input(
          4,
          2,
          true,
          states([-1, true], [-2, true], [3, false], [3, false])
        ),
        PARTIAL,
      ],
      [
        '-0 and 0 are one unit',
        input(2, 1, true, states([0, true], [-0, false])),
        AVAILABLE,
      ],
      ['duplicates, states missing', input(3, 1, true), 'unreadable'],
      ['duplicates, empty list', input(3, 1, true, []), 'unreadable'],
      [
        'duplicates, short list',
        input(3, 1, true, states([1, true], [1, false])),
        'unreadable',
      ],
      [
        'duplicates, long list',
        input(
          3,
          1,
          true,
          states([1, true], [1, false], [2, false], [3, false])
        ),
        'unreadable',
      ],
      [
        'downloaded rows differ from the download count',
        input(3, 1, true, states([1, true], [1, false], [2, true])),
        'unreadable',
      ],
      [
        'non-finite chapter number',
        input(2, 1, true, states([1, true], [Number.NaN, false])),
        'unreadable',
      ],
      [
        'non-boolean download state',
        input(2, 1, true, [
          { chapterNumber: 1, isDownloaded: true },
          { chapterNumber: 1, isDownloaded: 'no' as never },
        ]),
        'unreadable',
      ],
      [
        'missing row',
        input(2, 1, true, [
          { chapterNumber: 1, isDownloaded: true },
          null as never,
        ]),
        'unreadable',
      ],
      ['negative chapter count', input(-1, 0, false), 'unreadable'],
      ['fractional download count', input(3, 1.5, false), 'unreadable'],
      ['non-boolean duplicate flag', input(3, 1, 'yes' as never), 'unreadable'],
    ];
    for (const [label, value, expected] of cases) {
      assert.equal(computeMangaAvailability(value), expected, label);
    }
  });

  it('does not change its input', () => {
    const value = Object.freeze(
      input(3, 2, true, Object.freeze(states([1, true], [1, false], [2, true])))
    );
    assert.equal(computeMangaAvailability(value), AVAILABLE);
  });
});

describe('needsMangaChapterStates', () => {
  it('asks for chapter states only for a partial with duplicate numbers', () => {
    const cases: [MangaAvailabilityInput, boolean][] = [
      [input(3, 1, true), true],
      [input(3, 2, true), true],
      [input(3, 1, false), false],
      [input(3, 0, true), false],
      [input(3, 3, true), false],
      [input(3, 4, true), false],
      [input(0, 0, true), false],
      [input(-3, 1, true), false],
    ];
    for (const [value, expected] of cases) {
      assert.equal(
        needsMangaChapterStates(value),
        expected,
        JSON.stringify(value)
      );
    }
  });

  it('agrees with computeMangaAvailability about when states are used', () => {
    for (const chapterCount of [0, 1, 2, 5]) {
      for (
        let downloadCount = 0;
        downloadCount <= chapterCount + 1;
        downloadCount += 1
      ) {
        for (const hasDuplicateChapters of [false, true]) {
          const value = input(
            chapterCount,
            downloadCount,
            hasDuplicateChapters
          );
          const result = computeMangaAvailability(value);
          assert.equal(
            result === 'unreadable',
            needsMangaChapterStates(value),
            JSON.stringify(value)
          );
        }
      }
    }
  });
});

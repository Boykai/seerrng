import type { AnilistMangaSummary } from '@server/api/anilist/manga';
import { MangaBindingConfidence } from '@server/entity/MangaSourceBinding';

/** Titles are compared and searched on at most this many code points. */
export const MANGA_TITLE_MATCH_MAX_LENGTH = 128;
/** Per-mille thresholds. HIGH also needs a lead over every other result. */
export const MANGA_TITLE_HIGH_SCORE = 920;
export const MANGA_TITLE_HIGH_MARGIN = 50;
export const MANGA_TITLE_MEDIUM_SCORE = 750;
const MAX_SYNONYMS = 20;

export type MangaTitleConfidence =
  | MangaBindingConfidence.HIGH
  | MangaBindingConfidence.MEDIUM
  | MangaBindingConfidence.LOW;

export interface MangaTitleProposal {
  anilistId: number;
  confidence: MangaTitleConfidence;
  /** Per-mille similarity of the best title, 0 to 1000. */
  score: number;
}

export type MangaTitleCandidate = Pick<
  AnilistMangaSummary,
  'id' | 'titles' | 'synonyms'
>;

const BRACKETED = /\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}|【[^【】]*】/gu;

const codePoints = (value: string): string[] => Array.from(value);

const truncate = (value: string): string =>
  codePoints(value).slice(0, MANGA_TITLE_MATCH_MAX_LENGTH).join('');

const withoutBrackets = (value: string): string => {
  let stripped = value;
  for (let previous = ''; previous !== stripped;) {
    previous = stripped;
    stripped = stripped.replace(BRACKETED, ' ');
  }
  return stripped;
};

const words = (value: string): string =>
  value.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();

/**
 * Comparable form of a title: compatibility-folded, lowercased, without
 * Latin diacritics (kana voicing marks stay), bracketed notes or punctuation.
 */
export const normalizeMangaTitle = (value: string): string => {
  const folded = value
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC');
  return truncate(words(withoutBrackets(folded)) || words(folded));
};

/** The text sent to AniList's search: brackets removed, spaces collapsed. */
export const mangaTitleSearchText = (value: string): string => {
  const collapse = (text: string) => text.replace(/\s+/gu, ' ').trim();
  return truncate(collapse(withoutBrackets(value)) || collapse(value));
};

const levenshteinRatio = (a: string[], b: string[]): number => {
  const longest = Math.max(a.length, b.length);
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / longest;
};

const sortedTokens = (value: string): string[] =>
  codePoints(value.split(' ').sort().join(' '));

/**
 * Similarity of two normalized titles from 0 to 1: the better of the
 * Levenshtein ratio and the same ratio over alphabetically sorted words.
 */
export const mangaTitleSimilarity = (a: string, b: string): number =>
  Math.max(
    levenshteinRatio(codePoints(a), codePoints(b)),
    levenshteinRatio(sortedTokens(a), sortedTokens(b))
  );

const titlesOf = (candidate: MangaTitleCandidate): string[] =>
  [
    candidate.titles.romaji,
    candidate.titles.english,
    candidate.titles.native,
    ...candidate.synonyms.slice(0, MAX_SYNONYMS),
  ]
    .filter((title): title is string => typeof title === 'string')
    .map(normalizeMangaTitle)
    .filter((title) => title.length > 0);

/**
 * The best AniList result for a library title, never a rejected one. The
 * confidence only orders the review queue: no proposal binds by itself.
 */
export const proposeMangaMatch = (
  libraryTitle: string,
  results: readonly MangaTitleCandidate[],
  rejected: ReadonlySet<number>
): MangaTitleProposal | null => {
  const target = normalizeMangaTitle(libraryTitle);
  if (!target) {
    return null;
  }
  const scores = new Map<number, { score: number; rank: number }>();
  results.forEach((candidate, rank) => {
    if (rejected.has(candidate.id) || scores.has(candidate.id)) {
      return;
    }
    const best = Math.max(
      0,
      ...titlesOf(candidate).map((title) =>
        Math.round(mangaTitleSimilarity(target, title) * 1000)
      )
    );
    scores.set(candidate.id, { score: best, rank });
  });
  const ranked = [...scores].sort(
    ([idA, a], [idB, b]) => b.score - a.score || a.rank - b.rank || idA - idB
  );
  if (ranked.length === 0) {
    return null;
  }
  const [anilistId, { score }] = ranked[0];
  const runnerUp = ranked[1]?.[1].score ?? 0;
  const confidence =
    score >= MANGA_TITLE_HIGH_SCORE &&
    score - runnerUp >= MANGA_TITLE_HIGH_MARGIN
      ? MangaBindingConfidence.HIGH
      : score >= MANGA_TITLE_MEDIUM_SCORE
        ? MangaBindingConfidence.MEDIUM
        : MangaBindingConfidence.LOW;
  return { anilistId, confidence, score };
};

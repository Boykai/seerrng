import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import { MangaBindingConfidence } from '@server/entity/MangaSourceBinding';
import {
  MANGA_TITLE_HIGH_MARGIN,
  MANGA_TITLE_HIGH_SCORE,
  MANGA_TITLE_MEDIUM_SCORE,
  mangaTitleSearchText,
  mangaTitleSimilarity,
  normalizeMangaTitle,
} from '@server/lib/mangaTitleMatch';

/** Suwayomi refuses longer search queries; MangaDex gets the same cap. */
export const MANGA_RESOLVER_QUERY_MAX_LENGTH = 200;
/** Per-mille scores below this are not candidates. */
export const MANGA_RESOLVER_SCORE_FLOOR = 500;
/** Added when the source credits a story or art staff member. */
export const MANGA_RESOLVER_AUTHOR_BONUS = 50;
const AUTHOR_SIMILARITY = 0.9;
const MAX_SYNONYMS = 20;
const STORY_OR_ART = /\b(story|art)\b/i;
const AUTHOR_SEPARATORS = /[,;&/]/;
/** Source languages that mean "several languages" in Suwayomi's catalog. */
const MULTI_LANGUAGES = new Set(['all', 'multi']);
const ORIGIN_LANGUAGES: Readonly<Record<string, string>> = {
  JP: 'ja',
  KR: 'ko',
  CN: 'zh',
  TW: 'zh',
};

export type MangaResolverTitle = Pick<
  AnilistMangaDetails,
  'titles' | 'synonyms' | 'format' | 'countryOfOrigin' | 'staff'
>;

/** Cuts to the query limit without splitting a surrogate pair. */
const cutQuery = (value: string): string =>
  value
    .slice(0, MANGA_RESOLVER_QUERY_MAX_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim();

/** Search texts in order, without blanks or titles that compare equal. */
const queriesFrom = (titles: readonly (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const title of titles) {
    if (!title) continue;
    const query = cutQuery(mangaTitleSearchText(title));
    const key = normalizeMangaTitle(query) || query;
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries;
};

/** MangaDex title searches: English, then romaji, then native. */
export const mangadexQueries = (
  title: MangaResolverTitle,
  limit: number
): string[] =>
  queriesFrom([
    title.titles.english,
    title.titles.romaji,
    title.titles.native,
  ]).slice(0, limit);

const primaryLanguage = (lang: string): string =>
  lang.toLowerCase().split(/[-_]/)[0];

/**
 * Title searches for one source: the native title first when the source's
 * language is the title's original language, else English, romaji, native.
 */
export const sourceQueries = (
  title: MangaResolverTitle,
  sourceLang: string,
  limit: number
): string[] => {
  const { english, romaji, native } = title.titles;
  const origin = ORIGIN_LANGUAGES[title.countryOfOrigin ?? ''];
  const nativeFirst =
    origin !== undefined && primaryLanguage(sourceLang) === origin;
  return queriesFrom(
    nativeFirst ? [native, romaji, english] : [english, romaji, native]
  ).slice(0, limit);
};

/**
 * Where a source's language ranks: its position in the preferred languages,
 * then multi-language sources. With no preferred languages every source
 * ranks equal; with some, any other language is not eligible (undefined).
 */
export const languageRank = (
  lang: string,
  preferred: readonly string[]
): number | undefined => {
  if (preferred.length === 0) return 0;
  const lower = lang.toLowerCase();
  const index = preferred.findIndex((entry) => entry.toLowerCase() === lower);
  if (index >= 0) return index;
  return MULTI_LANGUAGES.has(lower) ? preferred.length : undefined;
};

export interface MangaResolverProfile {
  titles: string[];
  authors: string[];
  /** One-shots and novels never rank above MEDIUM. */
  capped: boolean;
}

export const mangaResolverProfile = (
  title: MangaResolverTitle
): MangaResolverProfile => {
  const unique = (values: string[]) => [
    ...new Set(values.filter((value) => value.length > 0)),
  ];
  return {
    titles: unique(
      [
        title.titles.romaji,
        title.titles.english,
        title.titles.native,
        ...title.synonyms.slice(0, MAX_SYNONYMS),
      ]
        .filter((value): value is string => typeof value === 'string')
        .map(normalizeMangaTitle)
    ),
    authors: unique(
      title.staff
        .filter((credit) => STORY_OR_ART.test(credit.role))
        .map((credit) => normalizeMangaTitle(credit.name))
    ),
    capped: title.format === 'ONE_SHOT' || title.format === 'NOVEL',
  };
};

/** Per-mille similarity of a source manga to the title, with the bonus. */
export const scoreSourceManga = (
  profile: MangaResolverProfile,
  manga: { title: string; author?: string }
): number => {
  const target = normalizeMangaTitle(manga.title);
  if (!target) return 0;
  const best = Math.max(
    0,
    ...profile.titles.map((title) =>
      Math.round(mangaTitleSimilarity(target, title) * 1000)
    )
  );
  const credited = (manga.author ?? '')
    .split(AUTHOR_SEPARATORS)
    .map(normalizeMangaTitle)
    .filter((name) => name.length > 0)
    .some((name) =>
      profile.authors.some(
        (author) => mangaTitleSimilarity(name, author) >= AUTHOR_SIMILARITY
      )
    );
  return Math.min(1000, best + (credited ? MANGA_RESOLVER_AUTHOR_BONUS : 0));
};

export type MangaResolverConfidence =
  | MangaBindingConfidence.HIGH
  | MangaBindingConfidence.MEDIUM
  | MangaBindingConfidence.LOW;

/**
 * A source's best result, rated against that source's next one. Undefined
 * below the floor. Never a reason to bind: only an admin binds these.
 */
export const rateSourceMatch = (
  score: number,
  runnerUp: number,
  capped: boolean
): MangaResolverConfidence | undefined => {
  if (score < MANGA_RESOLVER_SCORE_FLOOR) return undefined;
  if (
    !capped &&
    score >= MANGA_TITLE_HIGH_SCORE &&
    score - runnerUp >= MANGA_TITLE_HIGH_MARGIN
  ) {
    return MangaBindingConfidence.HIGH;
  }
  return score >= MANGA_TITLE_MEDIUM_SCORE
    ? MangaBindingConfidence.MEDIUM
    : MangaBindingConfidence.LOW;
};

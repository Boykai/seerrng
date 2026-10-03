import type {
  AnilistMangaContentPolicy,
  AnilistMangaDetails,
  AnilistMangaFormat,
  AnilistMangaStaffCredit,
  AnilistMangaStatus,
  AnilistMangaSummary,
  AnilistMangaTitles,
} from '@server/api/anilist/manga';
import type Media from '@server/entity/Media';

export interface MangaCredit {
  id: number;
  name: string;
}

export interface MangaTag {
  name: string;
  rank?: number;
}

export interface MangaResult {
  id: number;
  mediaType: 'manga';
  provider: 'anilist';
  title: string;
  titles: AnilistMangaTitles;
  synonyms: string[];
  format?: AnilistMangaFormat;
  status?: AnilistMangaStatus;
  chapters?: number;
  volumes?: number;
  isAdult: boolean;
  idMal?: number;
  posterPath?: string;
  backdropPath?: string;
  genres: string[];
  startYear?: number;
  countryOfOrigin?: string;
  averageScore?: number;
  mediaInfo?: Media;
}

export interface MangaDetails extends MangaResult {
  description?: string;
  tags: MangaTag[];
  story: MangaCredit[];
  art: MangaCredit[];
  siteUrl?: string;
  startDate?: string;
  endDate?: string;
  /** Set by the details route: a library scan found it in Suwayomi. */
  inSuwayomiLibrary?: boolean;
}

const STORY_ROLES = new Set([
  'story & art',
  'story and art',
  'story',
  'original creator',
  'original story',
]);
const ART_ROLES = new Set([
  'story & art',
  'story and art',
  'art',
  'illustration',
]);

// Staff roles carry qualifiers such as "(English)" or chapter ranges; only the
// base role decides whether a credit is a story or an art credit.
const normalizeRole = (role: string): string =>
  role
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const creditsForRoles = (
  staff: AnilistMangaStaffCredit[],
  roles: ReadonlySet<string>
): MangaCredit[] => {
  const seen = new Set<number>();
  return staff.flatMap((member) => {
    if (!roles.has(normalizeRole(member.role)) || seen.has(member.id)) {
      return [];
    }
    seen.add(member.id);
    return [{ id: member.id, name: member.name }];
  });
};

export const mapMangaResult = (
  manga: AnilistMangaSummary,
  media?: Media
): MangaResult => ({
  id: manga.id,
  mediaType: 'manga',
  provider: 'anilist',
  title:
    manga.titles.english ?? manga.titles.romaji ?? manga.titles.native ?? '',
  titles: manga.titles,
  synonyms: manga.synonyms,
  format: manga.format,
  status: manga.status,
  chapters: manga.chapters,
  volumes: manga.volumes,
  isAdult: manga.isAdult,
  idMal: manga.idMal,
  posterPath: manga.coverImage,
  backdropPath: manga.bannerImage,
  genres: manga.genres,
  startYear: manga.startYear,
  countryOfOrigin: manga.countryOfOrigin,
  averageScore: manga.averageScore,
  mediaInfo: media,
});

export const mapMangaDetails = (
  manga: AnilistMangaDetails,
  policy: AnilistMangaContentPolicy,
  media?: Media
): MangaDetails => ({
  ...mapMangaResult(manga, media),
  description: manga.description,
  tags: manga.tags
    .filter((tag) => !tag.isSpoiler && (policy.includeAdult || !tag.isAdult))
    .map(({ name, rank }) => ({ name, rank })),
  story: creditsForRoles(manga.staff, STORY_ROLES),
  art: creditsForRoles(manga.staff, ART_ROLES),
  siteUrl: manga.siteUrl,
  startDate: manga.startDate,
  endDate: manga.endDate,
});

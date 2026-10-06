import { getRepository } from '@server/datasource';
import MangaSourceBinding, {
  MangaBindingState,
} from '@server/entity/MangaSourceBinding';
import { getSettings } from '@server/lib/settings';

export const MANGA_LIBRARY_PAGE_SIZE = 20;

export interface MangaLibraryTitlePage {
  /** AniList IDs on this page, most recently added first. */
  anilistIds: number[];
  /** Distinct library titles across all pages, before the content policy. */
  totalResults: number;
}

/**
 * One page of the distinct AniList titles in a configured Suwayomi library:
 * titles with an active binding that the library lists. A title's added date
 * is the creation time of its earliest such binding, which can predate the
 * binding becoming an active library match. Newer titles come first and the
 * lower AniList ID breaks ties.
 */
export const findMangaLibraryTitles = async (
  page: number
): Promise<MangaLibraryTitlePage> => {
  const instanceIds = getSettings().suwayomi.map((instance) => instance.id);
  if (instanceIds.length === 0) {
    return { anilistIds: [], totalResults: 0 };
  }

  const libraryBindings = () =>
    getRepository(MangaSourceBinding)
      .createQueryBuilder('binding')
      .where('binding.state = :state', { state: MangaBindingState.ACTIVE })
      .andWhere('binding.inLibrary = :inLibrary', { inLibrary: true })
      .andWhere('binding.instanceId IN (:...instanceIds)', { instanceIds });

  const count = await libraryBindings()
    .select('COUNT(DISTINCT binding.anilistId)', 'total')
    .getRawOne<{ total: number | string | null }>();
  const totalResults = Number(count?.total ?? 0);
  const offset = (page - 1) * MANGA_LIBRARY_PAGE_SIZE;
  if (offset >= totalResults) {
    return { anilistIds: [], totalResults };
  }

  const rows = await libraryBindings()
    .select('binding.anilistId', 'anilistId')
    .groupBy('binding.anilistId')
    .orderBy('MIN(binding.createdAt)', 'DESC')
    .addOrderBy('binding.anilistId', 'ASC')
    .offset(offset)
    .limit(MANGA_LIBRARY_PAGE_SIZE)
    .getRawMany<{ anilistId: number | string }>();

  return {
    anilistIds: rows.map((row) => Number(row.anilistId)),
    totalResults,
  };
};

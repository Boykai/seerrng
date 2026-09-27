import MusicBrainz from '@server/api/musicbrainz';
import OpenLibraryAPI from '@server/api/openlibrary';
import type { CatalogRuleMetadata } from '@server/lib/overrideRules';
import type { ReadarrSettings } from '@server/lib/settings';
import {
  getBookshelfBookDetails,
  parseBookshelfBookId,
} from '@server/utils/bookshelfCatalog';

export const getMusicOverrideMetadata = async (
  releaseGroupId: string
): Promise<CatalogRuleMetadata> => {
  try {
    const album = await new MusicBrainz().getReleaseGroupDetails({
      releaseGroupId,
    });
    return {
      genres: album.genres?.map((genre) => genre.name),
      keywords: album.tags?.map((tag) => tag.name),
    };
  } catch {
    return {};
  }
};

export const getBookOverrideMetadata = async (
  bookId: string,
  services: ReadarrSettings[]
): Promise<CatalogRuleMetadata> => {
  if (parseBookshelfBookId(bookId)) {
    const book = await getBookshelfBookDetails(services, bookId);
    return {
      genres: book?.subjects,
      keywords: book?.subjects,
      languages: book?.languages,
    };
  }

  try {
    const openLibrary = new OpenLibraryAPI();
    const [work, editions] = await Promise.all([
      openLibrary.getWork(bookId),
      openLibrary.getWorkEditions(bookId).catch(() => ({
        size: 0,
        entries: [],
      })),
    ]);
    return {
      genres: work.subjects,
      keywords: work.subjects,
      languages: [
        ...new Set(
          editions.entries
            .slice(0, 100)
            .flatMap((edition) => edition.languages ?? [])
            .map((language) => language.key)
        ),
      ],
    };
  } catch {
    return {};
  }
};

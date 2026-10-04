import { graphqlData, type FakeRequest } from '@server/test/fakeSuwayomi';
import type {
  FakeDispatchChapter,
  FakeDispatchSuwayomi,
} from '@server/test/fakeSuwayomiDispatch';

/**
 * A dispatch-fake chapter with the time Suwayomi stored it, in epoch seconds.
 * An `uploadDate` of 0 makes it undated.
 */
export type FakeReleaseChapter = FakeDispatchChapter & { fetchedAt?: number };

/** The defaults match the dispatch fake's chapter nodes. */
export const FAKE_UPLOAD_DATE = 1_700_000_000_000;
export const FAKE_FETCHED_AT = 1_700_000_000;

interface Row {
  id: number;
  mangaId: number;
  chapterNumber: number;
  uploadDate: number;
  fetchedAt: number;
  isDownloaded: boolean;
}

const connection = (rows: Row[], after: unknown, pageSize: number) => {
  const remaining =
    typeof after === 'string'
      ? rows.filter((row) => row.id > Number(after))
      : rows;
  const nodes = remaining.slice(0, pageSize);
  return {
    pageInfo: {
      hasNextPage: remaining.length > nodes.length,
      endCursor: nodes.length ? String(nodes[nodes.length - 1].id) : null,
    },
    nodes: nodes.map((row) => ({
      ...row,
      uploadDate: String(row.uploadDate),
      fetchedAt: String(row.fetchedAt),
    })),
  };
};

/**
 * Serves ChapterReleases from the dispatch fake's state, as Suwayomi filters
 * it: the requested manga's chapters by upload date, and undated ones by
 * when they were stored, each list in ID order with `pageSize` rows a page.
 */
export const serveFakeChapterReleases = (
  fake: FakeDispatchSuwayomi,
  { pageSize = 500 }: { pageSize?: number } = {}
): void => {
  fake.server.onOperation('ChapterReleases', (request: FakeRequest) => {
    const variables = request.variables;
    const ids = new Set(
      (Array.isArray(variables.ids) ? variables.ids : []).map(Number)
    );
    const mangas = fake.state.mangas.filter((manga) => ids.has(manga.id));
    const rows = mangas
      .flatMap((manga) =>
        manga.chapters.map((chapter: FakeReleaseChapter, index) => ({
          id: chapter.id,
          mangaId: manga.id,
          chapterNumber: chapter.chapterNumber,
          uploadDate: chapter.uploadDate ?? FAKE_UPLOAD_DATE + index,
          fetchedAt: chapter.fetchedAt ?? FAKE_FETCHED_AT + index,
          isDownloaded: chapter.isDownloaded,
        }))
      )
      .sort((left, right) => left.id - right.id);
    const within = (value: number, from: unknown, before: unknown) =>
      value >= Number(from) && value < Number(before);
    return graphqlData({
      mangas: {
        nodes: mangas.map(({ id, sourceId, url }) => ({ id, sourceId, url })),
      },
      uploaded: connection(
        rows.filter((row) =>
          within(
            row.uploadDate,
            variables.uploadedFrom,
            variables.uploadedBefore
          )
        ),
        variables.uploadedAfter,
        pageSize
      ),
      undated: connection(
        rows.filter(
          (row) =>
            row.uploadDate <= 0 &&
            within(
              row.fetchedAt,
              variables.fetchedFrom,
              variables.fetchedBefore
            )
        ),
        variables.undatedAfter,
        pageSize
      ),
    });
  });
};

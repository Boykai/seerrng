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
 * EarlierChapterReleases lists the asked chapter numbers dated before
 * `uploadedBefore` or, undated, stored before `fetchedBefore`. `observe`
 * sees every request before it is answered, and the answer waits for it.
 */
export const serveFakeChapterReleases = (
  fake: FakeDispatchSuwayomi,
  {
    pageSize = 500,
    observe,
  }: {
    pageSize?: number;
    observe?: (request: FakeRequest) => void | Promise<void>;
  } = {}
): void => {
  const rowsOf = (ids: unknown) => {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number));
    const mangas = fake.state.mangas.filter((manga) => wanted.has(manga.id));
    const rows = mangas
      .flatMap((manga) =>
        manga.chapters.map((chapter: FakeReleaseChapter, index): Row => ({
          id: chapter.id,
          mangaId: manga.id,
          chapterNumber: chapter.chapterNumber,
          uploadDate: chapter.uploadDate ?? FAKE_UPLOAD_DATE + index,
          fetchedAt: chapter.fetchedAt ?? FAKE_FETCHED_AT + index,
          isDownloaded: chapter.isDownloaded,
        }))
      )
      .sort((left, right) => left.id - right.id);
    return { mangas, rows };
  };
  fake.server.onOperation('ChapterReleases', async (request: FakeRequest) => {
    await observe?.(request);
    const variables = request.variables;
    const { mangas, rows } = rowsOf(variables.ids);
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
  fake.server.onOperation('EarlierChapterReleases', async (request) => {
    await observe?.(request);
    const variables = request.variables;
    const match = (Array.isArray(variables.match) ? variables.match : []) as {
      mangaId?: { equalTo?: unknown };
      chapterNumber?: { in?: unknown };
    }[];
    const asked = (row: Row) =>
      match.some(
        (item) =>
          item.mangaId?.equalTo === row.mangaId &&
          Array.isArray(item.chapterNumber?.in) &&
          item.chapterNumber.in.includes(row.chapterNumber)
      );
    return graphqlData({
      chapters: connection(
        rowsOf(variables.ids).rows.filter(
          (row) =>
            asked(row) &&
            (row.uploadDate > 0
              ? row.uploadDate < Number(variables.uploadedBefore)
              : row.fetchedAt < Number(variables.fetchedBefore))
        ),
        variables.after,
        pageSize
      ),
    });
  });
};

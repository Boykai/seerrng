import type { SuwayomiCallClass } from '@server/api/suwayomi/types';

/**
 * Every GraphQL document this client sends, written by hand against the
 * pinned Suwayomi release. No schema text is stored in this repository; the
 * contract job validates these documents against a live, disposable server.
 *
 * Rules (enforced by operations.test.ts):
 * - one named operation per document, no fragments, no subscriptions;
 * - root fields come from the allow-lists below, so extension, extension
 *   store, settings mutation, tracker and file-deletion root fields are never
 *   sent; the library scan reads only `trackerId` and `remoteId` of a
 *   manga's track records;
 * - `settings` selects only non-secret fields.
 *
 * Auth levels: `none` never carries credentials (login and refresh), `public`
 * carries Basic credentials only, and `user` carries the configured
 * credentials or access token.
 */
export type SuwayomiAuthLevel = 'none' | 'public' | 'user';

export interface SuwayomiOperation {
  callClass: SuwayomiCallClass;
  auth: SuwayomiAuthLevel;
  document: string;
}

export const REQUEST_STAMP_KEY = 'seerrng.request';
export const REQUEST_INDEX_PREFIX = 'seerrng.request.';
export const INSTANCE_MARKER_KEY = 'seerrng.instance';

const MANGA_SUMMARY_FIELDS =
  'id sourceId url title author status inLibrary initialized';
const MANGA_DETAIL_FIELDS = `${MANGA_SUMMARY_FIELDS} artist description genre
  inLibraryAt lastFetchedAt chaptersLastFetchedAt downloadCount unreadCount
  hasDuplicateChapters chapters { totalCount } meta { key value }`;
const CHAPTER_FIELDS = `id mangaId url name chapterNumber scanlator uploadDate
  sourceOrder pageCount isDownloaded`;
const QUEUE_FIELDS =
  'downloadStatus { state queue { state progress tries chapter { id mangaId } } }';
const CATEGORY_FIELDS = 'id name includeInUpdate includeInDownload';

const op = (
  callClass: SuwayomiCallClass,
  auth: SuwayomiAuthLevel,
  document: string
): SuwayomiOperation => ({ callClass, auth, document });

export const SUWAYOMI_OPERATIONS = {
  Probe: op(
    'query',
    'public',
    'query Probe { aboutServer { name version buildType } }'
  ),
  // Suwayomi refuses introspection that selects `__schema`, `__type` or
  // `__Type.fields` more than once per request, so one `types` list carries
  // the root, manga and chapter field names.
  Capabilities: op(
    'query',
    'user',
    `query Capabilities {
      aboutServer { name version buildType }
      __schema {
        queryType { name }
        mutationType { name }
        types { name fields(includeDeprecated: true) { name } }
      }
    }`
  ),
  AuthTest: op('query', 'user', 'query AuthTest { downloadStatus { state } }'),
  Health: op(
    'query',
    'user',
    `query Health {
      aboutServer { version }
      settings {
        downloadAsCbz autoDownloadNewChapters excludeEntryWithUnreadChapters
        excludeUnreadChapters excludeNotStarted globalUpdateInterval
        maxSourcesInParallel flareSolverrEnabled
      }
      downloadStatus { state queue { state } }
      sources { totalCount }
    }`
  ),
  Sources: op(
    'query',
    'user',
    `query Sources {
      sources {
        nodes {
          id name displayName lang contentWarning supportsLatest
          extension { hasUpdate isObsolete }
        }
      }
    }`
  ),
  ByNaturalKey: op(
    'query',
    'user',
    `query ByNaturalKey($sourceId: LongString!, $url: String!) {
      mangas(condition: { sourceId: $sourceId, url: $url }) {
        nodes { ${MANGA_DETAIL_FIELDS} }
      }
    }`
  ),
  MangaDetails: op(
    'query',
    'user',
    `query MangaDetails($id: Int!) { manga(id: $id) { ${MANGA_DETAIL_FIELDS} } }`
  ),
  FindCategory: op(
    'query',
    'user',
    `query FindCategory($name: String!) {
      categories(condition: { name: $name }) { nodes { ${CATEGORY_FIELDS} } }
    }`
  ),
  ReverseIndex: op(
    'query',
    'user',
    `query ReverseIndex($after: Cursor) {
      metas(filter: { key: { startsWith: "${REQUEST_INDEX_PREFIX}" } }, first: 500, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { key value }
      }
    }`
  ),
  InstanceMarker: op(
    'query',
    'user',
    `query InstanceMarker { meta(key: "${INSTANCE_MARKER_KEY}") { key value } }`
  ),
  ChaptersToDownload: op(
    'query',
    'user',
    `query ChaptersToDownload($mangaId: Int!) {
      chapters(
        condition: { mangaId: $mangaId, isDownloaded: false }
        order: [{ by: SOURCE_ORDER, byType: DESC }]
      ) { nodes { ${CHAPTER_FIELDS} } }
    }`
  ),
  DownloadedChapters: op(
    'query',
    'user',
    `query DownloadedChapters($mangaId: Int!) {
      chapters(
        condition: { mangaId: $mangaId, isDownloaded: true }
        order: [{ by: SOURCE_ORDER, byType: DESC }]
      ) { nodes { ${CHAPTER_FIELDS} } }
    }`
  ),
  ChapterStates: op(
    'query',
    'user',
    `query ChapterStates($ids: [Int!]!) {
      chapters(filter: { id: { in: $ids } }) { nodes { id mangaId isDownloaded } }
    }`
  ),
  Queue: op('query', 'user', `query Queue { ${QUEUE_FIELDS} }`),
  Availability: op(
    'query',
    'user',
    `query Availability($ids: [Int!]!) {
      mangas(filter: { id: { in: $ids } }, first: 100) {
        nodes {
          id inLibrary status downloadCount hasDuplicateChapters
          chaptersLastFetchedAt chapters { totalCount }
        }
      }
      ${QUEUE_FIELDS}
    }`
  ),
  // Stored chapters only: nothing here makes Suwayomi contact a source.
  // `uploaded` filters on the source's upload date (epoch milliseconds);
  // `undated` holds chapters without one, by when Suwayomi stored them
  // (epoch seconds).
  ChapterReleases: op(
    'query',
    'user',
    `query ChapterReleases(
      $ids: [Int!]!
      $uploadedFrom: LongString!
      $uploadedBefore: LongString!
      $fetchedFrom: LongString!
      $fetchedBefore: LongString!
      $uploadedAfter: Cursor
      $undatedAfter: Cursor
    ) {
      mangas(filter: { id: { in: $ids } }, first: 100) { nodes { id sourceId url } }
      uploaded: chapters(
        filter: {
          mangaId: { in: $ids }
          uploadDate: { greaterThanOrEqualTo: $uploadedFrom, lessThan: $uploadedBefore }
        }
        order: [{ by: ID }]
        first: 500
        after: $uploadedAfter
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { id mangaId chapterNumber uploadDate fetchedAt isDownloaded }
      }
      undated: chapters(
        filter: {
          mangaId: { in: $ids }
          uploadDate: { lessThanOrEqualTo: "0" }
          fetchedAt: { greaterThanOrEqualTo: $fetchedFrom, lessThan: $fetchedBefore }
        }
        order: [{ by: ID }]
        first: 500
        after: $undatedAfter
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { id mangaId chapterNumber uploadDate fetchedAt isDownloaded }
      }
    }`
  ),
  LibraryPage: op(
    'query',
    'user',
    `query LibraryPage($after: Cursor) {
      mangas(
        condition: { inLibrary: true }
        order: [{ by: ID }]
        first: 100
        after: $after
      ) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id sourceId url title downloadCount hasDuplicateChapters
          chapters { totalCount }
        }
      }
    }`
  ),
  LibraryTrackRecords: op(
    'query',
    'user',
    `query LibraryTrackRecords($ids: [Int!]!) {
      mangas(filter: { id: { in: $ids } }, first: 100) {
        nodes { id trackRecords { nodes { trackerId remoteId } } }
      }
    }`
  ),
  LibraryChapterStates: op(
    'query',
    'user',
    `query LibraryChapterStates($ids: [Int!]!) {
      mangas(filter: { id: { in: $ids } }, first: 100) {
        nodes { id chapters { totalCount nodes { chapterNumber isDownloaded } } }
      }
    }`
  ),
  Login: op(
    'mutation',
    'none',
    `mutation Login($username: String!, $password: String!) {
      login(input: { username: $username, password: $password }) { accessToken refreshToken }
    }`
  ),
  Refresh: op(
    'mutation',
    'none',
    `mutation Refresh($refreshToken: String!) {
      refreshToken(input: { refreshToken: $refreshToken }) { accessToken }
    }`
  ),
  CreateCategory: op(
    'mutation',
    'user',
    `mutation CreateCategory($name: String!) {
      createCategory(input: { name: $name }) { category { ${CATEGORY_FIELDS} } }
    }`
  ),
  SetInLibrary: op(
    'mutation',
    'user',
    `mutation SetInLibrary($id: Int!, $inLibrary: Boolean!) {
      updateManga(input: { id: $id, patch: { inLibrary: $inLibrary } }) { manga { id inLibrary } }
    }`
  ),
  AddMangaToCategory: op(
    'mutation',
    'user',
    `mutation AddMangaToCategory($id: Int!, $categoryId: Int!) {
      updateMangaCategories(input: { id: $id, patch: { addToCategories: [$categoryId] } }) { manga { id } }
    }`
  ),
  RemoveMangaFromCategory: op(
    'mutation',
    'user',
    `mutation RemoveMangaFromCategory($id: Int!, $categoryId: Int!) {
      updateMangaCategories(input: { id: $id, patch: { removeFromCategories: [$categoryId] } }) { manga { id } }
    }`
  ),
  SetRequestStamp: op(
    'mutation',
    'user',
    `mutation SetRequestStamp($mangaId: Int!, $value: String!) {
      setMangaMeta(input: { meta: { mangaId: $mangaId, key: "${REQUEST_STAMP_KEY}", value: $value } }) {
        meta { key }
      }
    }`
  ),
  DeleteRequestStamp: op(
    'mutation',
    'user',
    `mutation DeleteRequestStamp($mangaId: Int!) {
      deleteMangaMeta(input: { mangaId: $mangaId, key: "${REQUEST_STAMP_KEY}" }) { meta { key } }
    }`
  ),
  SetRequestIndex: op(
    'mutation',
    'user',
    `mutation SetRequestIndex($key: String!, $value: String!) {
      setGlobalMeta(input: { meta: { key: $key, value: $value } }) { meta { key } }
    }`
  ),
  DeleteRequestIndex: op(
    'mutation',
    'user',
    `mutation DeleteRequestIndex($key: String!) {
      deleteGlobalMeta(input: { key: $key }) { meta { key } }
    }`
  ),
  SetInstanceMarker: op(
    'mutation',
    'user',
    `mutation SetInstanceMarker($value: String!) {
      setGlobalMeta(input: { meta: { key: "${INSTANCE_MARKER_KEY}", value: $value } }) { meta { key } }
    }`
  ),
  EnqueueChapters: op(
    'queue',
    'user',
    `mutation EnqueueChapters($ids: [Int!]!) {
      enqueueChapterDownloads(input: { ids: $ids }) { downloadStatus { state } }
    }`
  ),
  DequeueChapters: op(
    'queue',
    'user',
    `mutation DequeueChapters($ids: [Int!]!) {
      dequeueChapterDownloads(input: { ids: $ids }) { downloadStatus { state } }
    }`
  ),
  StartDownloader: op(
    'queue',
    'user',
    'mutation StartDownloader { startDownloader(input: {}) { downloadStatus { state } } }'
  ),
  SearchSource: op(
    'source',
    'user',
    `mutation SearchSource($source: LongString!, $query: String!, $page: Int!) {
      fetchSourceManga(input: { source: $source, type: SEARCH, query: $query, page: $page }) {
        hasNextPage
        mangas { ${MANGA_SUMMARY_FIELDS} }
      }
    }`
  ),
  FetchMangaAndChapters: op(
    'source',
    'user',
    `mutation FetchMangaAndChapters($id: Int!, $fetchManga: Boolean!) {
      fetchMangaAndChapters(input: { id: $id, fetchManga: $fetchManga, fetchChapters: true }) {
        manga { ${MANGA_DETAIL_FIELDS} }
        chapters { ${CHAPTER_FIELDS} }
      }
    }`
  ),
} satisfies Record<string, SuwayomiOperation>;

export type SuwayomiOperationName = keyof typeof SUWAYOMI_OPERATIONS;

/**
 * Root fields the operations above use. Capabilities requires all of them,
 * and operations.test.ts rejects any other root field (introspection aside).
 */
export const ROOT_FIELDS = {
  query: [
    'aboutServer',
    'categories',
    'chapters',
    'downloadStatus',
    'manga',
    'mangas',
    'meta',
    'metas',
    'settings',
    'sources',
  ],
  mutation: [
    'createCategory',
    'deleteGlobalMeta',
    'deleteMangaMeta',
    'dequeueChapterDownloads',
    'enqueueChapterDownloads',
    'fetchMangaAndChapters',
    'fetchSourceManga',
    'login',
    'refreshToken',
    'setGlobalMeta',
    'setMangaMeta',
    'startDownloader',
    'updateManga',
    'updateMangaCategories',
  ],
} as const;

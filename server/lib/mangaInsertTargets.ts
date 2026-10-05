import type { InsertQueryBuilder, ObjectLiteral } from 'typeorm';

// The unique keys the manga insert-if-absent writes rely on. Each one matches
// the entity's @Unique columns; mangaInsertTargets.test.ts keeps them equal.
export const MANGA_INSTANCE_MARKER_KEY = ['instanceId'] as const;
export const MANGA_LIBRARY_OWNERSHIP_KEY = [
  'instanceId',
  'sourceId',
  'urlHash',
] as const;
export const MANGA_REQUEST_CHAPTER_KEY = ['manifestId', 'urlHash'] as const;
export const MANGA_CHAPTER_OWNERSHIP_KEY = [
  'instanceId',
  'sourceId',
  'mangaUrlHash',
  'chapterUrlHash',
] as const;

/**
 * Skips a row only when it conflicts on `key`. Any other conflict, such as
 * on the primary key or another unique column, still fails the insert.
 */
export const skipConflictOn = <Entity extends ObjectLiteral>(
  query: InsertQueryBuilder<Entity>,
  key: readonly string[]
): InsertQueryBuilder<Entity> => query.orUpdate([], [...key]);

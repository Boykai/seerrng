import dataSource, { getRepository } from '@server/datasource';
import MangaChapterOwnership from '@server/entity/MangaChapterOwnership';
import MangaInstanceMarker from '@server/entity/MangaInstanceMarker';
import MangaLibraryOwnership from '@server/entity/MangaLibraryOwnership';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import {
  MANGA_CHAPTER_OWNERSHIP_KEY,
  MANGA_INSTANCE_MARKER_KEY,
  MANGA_LIBRARY_OWNERSHIP_KEY,
  MANGA_REQUEST_CHAPTER_KEY,
  skipConflictOn,
} from './mangaInsertTargets';

setupTestDb();

const UNIQUE_VIOLATION =
  /UNIQUE constraint failed|duplicate key value violates unique constraint/;
const FIRST_MARKER = '6f1d8f5e-3c2b-4a1d-9e8f-7a6b5c4d3e2f';
const SECOND_MARKER = '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';

const TARGETS: [EntityTarget<ObjectLiteral>, string, readonly string[]][] = [
  [
    MangaInstanceMarker,
    'UQ_manga_instance_marker_instance',
    MANGA_INSTANCE_MARKER_KEY,
  ],
  [
    MangaLibraryOwnership,
    'UQ_manga_library_ownership_item',
    MANGA_LIBRARY_OWNERSHIP_KEY,
  ],
  [
    MangaRequestChapter,
    'UQ_manga_request_chapter_manifest_url',
    MANGA_REQUEST_CHAPTER_KEY,
  ],
  [
    MangaChapterOwnership,
    'UQ_manga_chapter_ownership_item',
    MANGA_CHAPTER_OWNERSHIP_KEY,
  ],
];

const conflictClause = (key: readonly string[]) =>
  `ON CONFLICT ( ${key.map((column) => `"${column}"`).join(', ')} ) DO NOTHING`;

const insertMarker = (instanceId: number, marker: string) =>
  skipConflictOn(
    dataSource
      .createQueryBuilder()
      .insert()
      .into(MangaInstanceMarker)
      .values({ instanceId, marker }),
    MANGA_INSTANCE_MARKER_KEY
  ).execute();

const insertChapterOwnership = (row: Partial<MangaChapterOwnership>) =>
  skipConflictOn(
    dataSource
      .createQueryBuilder()
      .insert()
      .into(MangaChapterOwnership)
      .values({
        instanceId: 1,
        sourceId: '1',
        mangaUrlHash: 'a'.repeat(64),
        chapterUrlHash: 'b'.repeat(64),
        chapterUrl: '/chapter/1',
        ...row,
      }),
    MANGA_CHAPTER_OWNERSHIP_KEY
  ).execute();

describe('manga insert conflict targets', () => {
  it('names one unique constraint of each table', () => {
    for (const [entity, name, key] of TARGETS) {
      const unique = dataSource
        .getMetadata(entity)
        .uniques.find((candidate) => candidate.name === name);
      assert.ok(unique, `${name} is missing.`);
      assert.deepStrictEqual(
        unique.columns.map(({ databaseName }) => databaseName),
        [...key]
      );
    }
  });

  it('skips only a conflict on that key, on both database drivers', () => {
    const postgres = new DataSource({ type: 'postgres' });
    for (const [entity, , key] of TARGETS) {
      const sqlite = skipConflictOn(
        dataSource.createQueryBuilder().insert().into(entity).values({}),
        key
      ).getQuery();
      const pg = skipConflictOn(
        postgres
          .createQueryBuilder()
          .insert()
          .into(dataSource.getMetadata(entity).tableName, [...key])
          .values({}),
        key
      ).getQuery();

      for (const sql of [sqlite, pg]) {
        assert.ok(sql.includes(conflictClause(key)), sql);
        assert.doesNotMatch(sql, /ON CONFLICT DO NOTHING/);
      }
    }
  });

  it('skips a repeated key but fails on another unique column or the primary key', async () => {
    await insertMarker(1, FIRST_MARKER);
    await insertMarker(1, SECOND_MARKER);
    await assert.rejects(insertMarker(2, FIRST_MARKER), UNIQUE_VIOLATION);
    assert.deepStrictEqual(
      (await getRepository(MangaInstanceMarker).find()).map(
        ({ instanceId, marker }) => [instanceId, marker]
      ),
      [[1, FIRST_MARKER]]
    );

    await insertChapterOwnership({});
    await insertChapterOwnership({ chapterUrl: '/chapter/1/again' });
    const [owned] = await getRepository(MangaChapterOwnership).find();
    await assert.rejects(
      insertChapterOwnership({ id: owned.id, chapterUrlHash: 'c'.repeat(64) }),
      UNIQUE_VIOLATION
    );
    assert.deepStrictEqual(
      (await getRepository(MangaChapterOwnership).find()).map(
        ({ chapterUrl }) => chapterUrl
      ),
      ['/chapter/1']
    );
  });
});

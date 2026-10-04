import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource, type QueryRunner } from 'typeorm';
import { AddMangaLibraryBindings1790986404000 } from './1790986404000-AddMangaLibraryBindings';

const insertBinding = (
  queryRunner: QueryRunner,
  values: {
    item: string;
    anilistId: number;
    state: string;
    instanceId?: number;
  }
) =>
  queryRunner.query(
    `INSERT INTO "manga_source_binding" ("instanceId", "sourceId", "url", "urlHash", "anilistId", "confidence", "matchedBy", "origin", "state")
     VALUES (?, '0', ?, ?, ?, 'TRACKER_LINK', 'anilist-tracker', 'library-scan', ?)`,
    [
      values.instanceId ?? 1,
      `/fake/${values.item}`,
      `hash-${values.item}`,
      values.anilistId,
      values.state,
    ]
  );

test('SQLite manga library migration enforces live and pair uniqueness reversibly', async () => {
  const dataSource = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
  }).initialize();
  const queryRunner = dataSource.createQueryRunner();
  const migration = new AddMangaLibraryBindings1790986404000();
  const objects = async () =>
    (
      (await queryRunner.query(
        `SELECT type, name FROM sqlite_master
         WHERE tbl_name IN ('manga_source_binding', 'manga_match_candidate')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
      )) as { type: string; name: string }[]
    ).map(({ type, name }) => `${type} ${name}`);
  try {
    await migration.up(queryRunner);
    await migration.up(queryRunner);

    assert.deepEqual(await objects(), [
      'index IDX_manga_source_binding_anilistId',
      'index UQ_manga_match_candidate_item',
      'index UQ_manga_source_binding_live',
      'index UQ_manga_source_binding_pair',
      'table manga_match_candidate',
      'table manga_source_binding',
    ]);

    await insertBinding(queryRunner, {
      item: 'a',
      anilistId: 10,
      state: 'ACTIVE',
    });
    assert.deepEqual(
      await queryRunner.query(
        `SELECT "inLibrary", "availability", "chapterCount", "createdAt" IS NOT NULL AS "stamped"
         FROM "manga_source_binding"`
      ),
      [{ inLibrary: 0, availability: 1, chapterCount: null, stamped: 1 }]
    );

    // One live binding per source manga, whichever live state it is in.
    await assert.rejects(
      insertBinding(queryRunner, {
        item: 'a',
        anilistId: 11,
        state: 'ORPHANED',
      }),
      /UNIQUE constraint failed/
    );
    await assert.rejects(
      insertBinding(queryRunner, { item: 'a', anilistId: 11, state: 'ACTIVE' }),
      /UNIQUE constraint failed/
    );
    // Rejections are per pair and coexist with the live binding.
    await insertBinding(queryRunner, {
      item: 'a',
      anilistId: 12,
      state: 'REJECTED',
    });
    await insertBinding(queryRunner, {
      item: 'a',
      anilistId: 13,
      state: 'REJECTED',
    });
    await assert.rejects(
      insertBinding(queryRunner, {
        item: 'a',
        anilistId: 12,
        state: 'REJECTED',
      }),
      /UNIQUE constraint failed/
    );
    await assert.rejects(
      insertBinding(queryRunner, {
        item: 'a',
        anilistId: 10,
        state: 'REJECTED',
      }),
      /UNIQUE constraint failed/
    );
    // The keys are per instance and per item.
    await insertBinding(queryRunner, {
      item: 'a',
      anilistId: 10,
      state: 'ACTIVE',
      instanceId: 2,
    });
    await insertBinding(queryRunner, {
      item: 'b',
      anilistId: 10,
      state: 'ACTIVE',
    });
    // Once the live binding is rejected, another one may take its place.
    await queryRunner.query(
      `UPDATE "manga_source_binding" SET "state" = 'REJECTED'
       WHERE "instanceId" = 1 AND "urlHash" = 'hash-a' AND "anilistId" = 10`
    );
    await insertBinding(queryRunner, {
      item: 'a',
      anilistId: 14,
      state: 'ORPHANED',
    });

    const insertCandidate = () =>
      queryRunner.query(
        `INSERT INTO "manga_match_candidate" ("instanceId", "sourceId", "url", "urlHash", "suwayomiMangaId", "title")
         VALUES (1, '0', '/fake/c', 'hash-c', 7, 'Fake Title')`
      );
    await insertCandidate();
    await assert.rejects(insertCandidate(), /UNIQUE constraint failed/);

    await migration.down(queryRunner);
    await migration.down(queryRunner);

    assert.deepEqual(await objects(), []);
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
});

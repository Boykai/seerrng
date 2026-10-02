import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  compareDriftStatements,
  describeDriftComparison,
  formatDriftAllowlist,
  normalizeDriftQuery,
  parseDriftAllowlist,
  selectRoundTripMigrations,
} from '@server/scripts/migrationDrift';

test('normalizeDriftQuery collapses whitespace and keeps parameters', () => {
  assert.equal(
    normalizeDriftQuery({
      query: '  CREATE INDEX "IDX_a"\n    ON "media" ("id")  ',
    }),
    'CREATE INDEX "IDX_a" ON "media" ("id")'
  );
  assert.equal(
    normalizeDriftQuery({
      query: 'DELETE FROM "typeorm_metadata"',
      parameters: [],
    }),
    'DELETE FROM "typeorm_metadata"'
  );
  assert.equal(
    normalizeDriftQuery({
      query: 'DELETE FROM "typeorm_metadata" WHERE "name" = $1',
      parameters: ['view'],
    }),
    'DELETE FROM "typeorm_metadata" WHERE "name" = $1 -- parameters: ["view"]'
  );
});

test('compareDriftStatements compares statements as a multiset', () => {
  assert.deepStrictEqual(compareDriftStatements(['a', 'b'], ['b', 'a']), {
    unexpected: [],
    stale: [],
  });
  assert.deepStrictEqual(compareDriftStatements(['a', 'a', 'c'], ['a', 'b']), {
    unexpected: ['a', 'c'],
    stale: ['b'],
  });
  assert.deepStrictEqual(compareDriftStatements([], ['a']), {
    unexpected: [],
    stale: ['a'],
  });
});

test('parseDriftAllowlist accepts only a description and string statements', () => {
  assert.deepStrictEqual(
    parseDriftAllowlist(
      '{"description":"reviewed","statements":["a","b"]}',
      'fixture'
    ),
    { description: 'reviewed', statements: ['a', 'b'] }
  );

  for (const source of [
    '[]',
    '{"statements":[]}',
    '{"description":"reviewed"}',
    '{"description":"reviewed","statements":[1]}',
    '{"description":1,"statements":[]}',
  ]) {
    assert.throws(
      () => parseDriftAllowlist(source, 'fixture.json'),
      /fixture\.json must be an object/
    );
  }
  assert.throws(() => parseDriftAllowlist('not json', 'fixture.json'));
});

test('formatDriftAllowlist writes stable JSON that parses back', () => {
  const allowlist = { description: 'reviewed', statements: ['a', 'b'] };
  const formatted = formatDriftAllowlist(allowlist);

  assert.ok(formatted.endsWith('}\n'));
  assert.deepStrictEqual(parseDriftAllowlist(formatted, 'fixture'), allowlist);
});

test('selectRoundTripMigrations reaches back to the oldest matching migration', () => {
  const executedNewestFirst = [
    'AddMangaQuota3',
    'AddUnrelated2',
    'AddMangaIdentityUniqueness1',
    'AddUserRequestRootFolders0',
  ];

  assert.deepStrictEqual(
    selectRoundTripMigrations(executedNewestFirst, /Manga/),
    ['AddMangaQuota3', 'AddUnrelated2', 'AddMangaIdentityUniqueness1']
  );
  assert.deepStrictEqual(
    selectRoundTripMigrations(executedNewestFirst, /Missing/),
    []
  );
  assert.deepStrictEqual(selectRoundTripMigrations([], /Manga/), []);
});

test('describeDriftComparison lists unexpected and stale statements', () => {
  assert.equal(
    describeDriftComparison('sqlite', { unexpected: [], stale: [] }),
    ''
  );
  assert.equal(
    describeDriftComparison('postgres', { unexpected: ['a'], stale: ['b'] }),
    [
      'postgres: 1 schema statement(s) are not produced by migrations and are not allowlisted:',
      '  + a',
      'postgres: 1 allowlisted statement(s) no longer appear; remove them from the allowlist:',
      '  - b',
    ].join('\n')
  );
});

test('the committed drift allowlists parse and never cover manga schema objects', () => {
  for (const driver of ['sqlite', 'postgres']) {
    const allowlistPath = path.join(
      __dirname,
      'migration-drift-allowlist',
      `${driver}.json`
    );
    const allowlist = parseDriftAllowlist(
      readFileSync(allowlistPath, 'utf8'),
      allowlistPath
    );

    assert.ok(allowlist.statements.length > 0, `${driver} allowlist is empty`);
    assert.deepStrictEqual(
      allowlist.statements.filter((statement) => /manga/i.test(statement)),
      [],
      `${driver} allowlist must not hide manga drift`
    );
  }
});

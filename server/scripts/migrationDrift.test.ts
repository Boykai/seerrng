import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type {
  DriftAllowlist,
  DriftRecord,
  SchemaRecord,
} from '@server/scripts/migrationDrift';
import {
  buildDriftAllowlist,
  checkDriftAllowlist,
  describeDriftCheck,
  diffSchemaRecords,
  formatDriftAllowlist,
  normalizeSqlExpression,
  parseDriftAllowlist,
  recordsFromTables,
  selectRoundTripMigrations,
} from '@server/scripts/migrationDrift';
import type { TableColumnOptions } from 'typeorm';
import { Table } from 'typeorm';

// A user table that already drifts: the migrations created spotifyUserId as
// varchar while the entity declares text.
const userTable = (
  spotifyUserIdType: string,
  extraColumns: TableColumnOptions[] = []
) =>
  new Table({
    name: 'user',
    columns: [
      {
        name: 'id',
        type: 'integer',
        isPrimary: true,
        isGenerated: true,
        generationStrategy: 'increment',
      },
      { name: 'spotifyUserId', type: spotifyUserIdType, isNullable: true },
      ...extraColumns,
    ],
  });

const mangaQuotaLimit: TableColumnOptions = {
  name: 'mangaQuotaLimit',
  type: 'integer',
  isNullable: true,
};

const existingDrift = diffSchemaRecords(
  recordsFromTables([userTable('varchar')]),
  recordsFromTables([userTable('text')])
);

const reviewed: DriftAllowlist = {
  description: 'reviewed',
  records: existingDrift.map((entry) => ({
    ...entry,
    reason: 'The migration created varchar; the entity declares text.',
  })),
};

const column = (name: string, type = 'integer'): SchemaRecord => ({
  kind: 'column',
  table: 'user',
  name,
  type,
  nullable: true,
  default: null,
  primary: false,
  generated: null,
  unique: false,
});

test('existing drift is one record per side for the object that differs', () => {
  assert.deepStrictEqual(existingDrift, [
    { side: 'entities', record: column('spotifyUserId', 'text') },
    { side: 'migrations', record: column('spotifyUserId', 'varchar') },
  ]);
});

test('a correct column add on a drifting table yields no record', () => {
  const drift = diffSchemaRecords(
    recordsFromTables([userTable('varchar', [mangaQuotaLimit])]),
    recordsFromTables([userTable('text', [mangaQuotaLimit])])
  );

  assert.deepStrictEqual(drift, existingDrift);
  assert.deepStrictEqual(checkDriftAllowlist(drift, reviewed), {
    unexpected: [],
    stale: [],
    forbidden: [],
  });
});

test('an entity column without a migration yields a record', () => {
  const drift = diffSchemaRecords(
    recordsFromTables([userTable('varchar')]),
    recordsFromTables([userTable('text', [mangaQuotaLimit])])
  );
  const added: DriftRecord = {
    side: 'entities',
    record: column('mangaQuotaLimit'),
  };

  assert.deepStrictEqual(checkDriftAllowlist(drift, reviewed), {
    unexpected: [added],
    stale: [],
    forbidden: [],
  });
  assert.throws(
    () => buildDriftAllowlist(drift, reviewed, 'reviewed'),
    /Refusing to allowlist 1 manga drift record\(s\)/
  );
});

test('a manga-named allowlist entry fails even when it matches the drift', () => {
  const drift = diffSchemaRecords(
    recordsFromTables([userTable('varchar')]),
    recordsFromTables([userTable('text', [mangaQuotaLimit])])
  );
  const allowlist: DriftAllowlist = {
    description: 'reviewed',
    records: drift.map((entry) => ({ ...entry, reason: 'accepted' })),
  };
  const check = checkDriftAllowlist(drift, allowlist);

  assert.deepStrictEqual(check.unexpected, []);
  assert.deepStrictEqual(check.stale, []);
  assert.deepStrictEqual(
    check.forbidden.map(({ record }) => record),
    [column('mangaQuotaLimit')]
  );
  assert.match(
    describeDriftCheck('sqlite', check),
    /^sqlite: 1 allowlisted record\(s\) mention manga; manga drift must be fixed, never allowlisted:\n {2}\+ entities only: \{"kind":"column","table":"user","name":"mangaQuotaLimit"/
  );
});

test('a stale allowlist entry fails', () => {
  const check = checkDriftAllowlist([], reviewed);

  assert.deepStrictEqual(check.unexpected, []);
  assert.deepStrictEqual(check.stale, reviewed.records);
  assert.deepStrictEqual(check.forbidden, []);
  assert.match(
    describeDriftCheck('postgres', check),
    /^postgres: 2 allowlisted record\(s\) no longer drift; remove them from the allowlist:\n {2}\+ entities only: /
  );
});

test('recordsFromTables keeps index key order and orders foreign key pairs', () => {
  const table = new Table({
    name: 'media_identifier',
    columns: [
      { name: 'provider', type: 'character varying', length: '32' },
      { name: 'value', type: 'character varying', default: "''::text" },
    ],
    indices: [
      {
        name: 'UQ_fixture',
        columnNames: ['value', 'provider'],
        isUnique: true,
        where: '("provider")::text = \'example\'::text',
      },
    ],
    foreignKeys: [
      {
        columnNames: ['value', 'provider'],
        referencedTableName: 'media',
        referencedColumnNames: ['b', 'a'],
        onDelete: 'cascade',
      },
    ],
    checks: [{ name: 'CHK_fixture', expression: '("value" <> \'\')' }],
  });
  const keyOrder = new Map([['UQ_fixture', ['provider', 'value']]]);

  assert.deepStrictEqual(recordsFromTables([table], { keyOrder }).slice(1), [
    {
      kind: 'column',
      table: 'media_identifier',
      name: 'provider',
      type: 'character varying(32)',
      nullable: false,
      default: null,
      primary: false,
      generated: null,
      unique: false,
    },
    {
      kind: 'column',
      table: 'media_identifier',
      name: 'value',
      type: 'character varying',
      nullable: false,
      default: "''::text",
      primary: false,
      generated: null,
      unique: false,
    },
    {
      kind: 'index',
      table: 'media_identifier',
      name: 'UQ_fixture',
      columns: ['provider', 'value'],
      unique: true,
      where: "(provider)::text = 'example'::text",
    },
    {
      kind: 'foreignKey',
      table: 'media_identifier',
      columns: ['provider', 'value'],
      referencedTable: 'media',
      referencedColumns: ['a', 'b'],
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION',
    },
  ]);
  assert.deepStrictEqual(
    recordsFromTables([table], { checks: true, keyOrder }).at(-1),
    {
      kind: 'check',
      table: 'media_identifier',
      name: 'CHK_fixture',
      expression: "value <> ''",
    }
  );
});

test('normalizeSqlExpression drops formatting but keeps string literals', () => {
  assert.equal(
    normalizeSqlExpression('  ( "provider"  =  \'a  b\' )  '),
    "provider = 'a  b'"
  );
  assert.equal(normalizeSqlExpression('((x))'), 'x');
  assert.equal(normalizeSqlExpression('(a) OR (b)'), '(a)OR(b)');
  assert.equal(
    normalizeSqlExpression("(a = ')' AND b = '(')"),
    "a = ')' AND b = '('"
  );
  assert.equal(
    normalizeSqlExpression('lower( "Name" , \'x\' )'),
    "lower(Name,'x')"
  );
  assert.equal(normalizeSqlExpression(0), '0');
  assert.equal(normalizeSqlExpression(''), null);
  assert.equal(normalizeSqlExpression(null), null);
  assert.equal(normalizeSqlExpression(undefined), null);
});

test('buildDriftAllowlist keeps reasons for records that still drift', () => {
  const drift: DriftRecord[] = [
    ...existingDrift,
    { side: 'migrations', record: column('legacy') },
  ];
  const allowlist = buildDriftAllowlist(
    drift,
    {
      description: 'old',
      records: [
        ...reviewed.records,
        { side: 'migrations', record: column('gone'), reason: 'fixed since' },
      ],
    },
    'new'
  );

  assert.equal(allowlist.description, 'new');
  assert.deepStrictEqual(
    allowlist.records.map(({ reason }) => reason),
    [...reviewed.records.map(({ reason }) => reason), '']
  );
  assert.deepStrictEqual(
    allowlist.records.map(({ side, record }) => ({ side, record })),
    drift
  );
});

test('parseDriftAllowlist requires a side, a schema record and a reason', () => {
  const formatted = formatDriftAllowlist(reviewed);

  assert.ok(formatted.endsWith('}\n'));
  assert.deepStrictEqual(parseDriftAllowlist(formatted, 'fixture'), reviewed);

  for (const source of [
    '[]',
    '{"records":[]}',
    '{"description":"reviewed"}',
    '{"description":1,"records":[]}',
  ]) {
    assert.throws(
      () => parseDriftAllowlist(source, 'fixture.json'),
      /fixture\.json must be an object/
    );
  }

  const record = JSON.stringify(column('id'));
  for (const entry of [
    `{"side":"migrations","record":${record}}`,
    `{"side":"both","record":${record},"reason":"x"}`,
    '{"side":"migrations","record":{"kind":"view"},"reason":"x"}',
  ]) {
    assert.throws(
      () =>
        parseDriftAllowlist(
          `{"description":"d","records":[${entry}]}`,
          'fixture.json'
        ),
      /fixture\.json: records\[0\] needs a reason, a side/
    );
  }

  const unexplained = `{"description":"d","records":[{"side":"migrations","record":${record},"reason":" "}]}`;
  assert.throws(
    () => parseDriftAllowlist(unexplained, 'fixture.json'),
    /records\[0\] has no reason/
  );
  assert.equal(
    parseDriftAllowlist(unexplained, 'fixture.json', { requireReasons: false })
      .records.length,
    1
  );
  assert.throws(() => parseDriftAllowlist('not json', 'fixture.json'));
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

test('the committed drift allowlists have reasons and never cover manga', () => {
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

    assert.ok(allowlist.records.length > 0, `${driver} allowlist is empty`);
    assert.deepStrictEqual(
      checkDriftAllowlist(
        allowlist.records.map(({ side, record }) => ({ side, record })),
        allowlist
      ),
      { unexpected: [], stale: [], forbidden: [] },
      `${driver} allowlist must not hide manga drift`
    );
  }
});

// Pure helpers for checkMigrationDrift.ts. One empty database is built by the
// migrations and another by synchronize() from the entities; both are read
// through the same introspection and reduced to schema records. Drift is every
// record that only one side has, so an object that differs appears once per
// side. Reviewed drift lives in migration-drift-allowlist/, one reason per
// record.
import type { Table, TableColumn } from 'typeorm';

export type DriftSide = 'migrations' | 'entities';

export type SchemaRecord =
  | { kind: 'table'; table: string }
  | {
      kind: 'column';
      table: string;
      name: string;
      type: string;
      nullable: boolean;
      default: string | null;
      primary: boolean;
      generated: string | null;
      unique: boolean;
    }
  | {
      kind: 'index';
      table: string;
      name: string;
      columns: string[];
      unique: boolean;
      where: string | null;
    }
  | { kind: 'unique'; table: string; name: string; columns: string[] }
  | {
      kind: 'foreignKey';
      table: string;
      columns: string[];
      referencedTable: string;
      referencedColumns: string[];
      onDelete: string;
      onUpdate: string;
    }
  | { kind: 'check'; table: string; name: string; expression: string }
  | { kind: 'enum'; name: string; values: string[] };

export interface DriftRecord {
  side: DriftSide;
  record: SchemaRecord;
}

export interface DriftAllowlistEntry extends DriftRecord {
  reason: string;
}

export interface DriftAllowlist {
  description: string;
  records: DriftAllowlistEntry[];
}

export interface DriftCheck {
  unexpected: DriftRecord[];
  stale: DriftAllowlistEntry[];
  forbidden: DriftAllowlistEntry[];
}

export interface RecordOptions {
  // PostgreSQL only: check constraints, and the key order of each index by
  // name (TypeORM's getTables() does not report key order there).
  checks?: boolean;
  keyOrder?: ReadonlyMap<string, string[]>;
}

const KINDS = [
  'table',
  'column',
  'index',
  'unique',
  'foreignKey',
  'check',
  'enum',
] as const;
const SIDES = ['migrations', 'entities'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

// Manga drift must be fixed, never allowlisted. The rule covers every table,
// column, index and constraint name in a record, and its expressions too.
export const mentionsManga = (record: SchemaRecord) =>
  /manga/i.test(JSON.stringify(record));

// Parentheses inside string literals do not count.
const wrapsWholeExpression = (expression: string) => {
  let depth = 0;
  let quoted = false;

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];

    if (character === "'") {
      quoted = !quoted;
    } else if (!quoted && character === '(') {
      depth += 1;
    } else if (!quoted && character === ')') {
      depth -= 1;
      if (depth === 0) {
        return index === expression.length - 1;
      }
    }
  }

  return false;
};

// Outside string literals, drops formatting that never changes meaning:
// whitespace runs, spaces around parentheses and commas, quotes around plain
// identifiers and parentheses around the whole expression. An empty
// expression (TypeORM stores a missing index WHERE as '') becomes null.
export const normalizeSqlExpression = (value: unknown) => {
  if (value === null || value === undefined) {
    return null;
  }

  let expression = String(value)
    .split(/('(?:[^']|'')*')/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/\s+/g, ' ')
            .replace(/"([A-Za-z_]\w*)"/g, '$1')
            .replace(/ ?([(),]) ?/g, '$1')
    )
    .join('')
    .trim();

  while (expression.startsWith('(') && wrapsWholeExpression(expression)) {
    expression = expression.slice(1, -1).trim();
  }

  return expression === '' ? null : expression;
};

const columnType = (column: TableColumn) => {
  const size = column.length
    ? [column.length]
    : [column.precision, column.scale].filter(
        (part) => part !== undefined && part !== null
      );
  const values = column.enum?.length
    ? ` enum(${column.enum.map((value) => `'${value}'`).join(',')})`
    : '';

  return `${column.type.toLowerCase()}${
    size.length > 0 ? `(${size.join(',')})` : ''
  }${column.isArray ? '[]' : ''}${values}`;
};

const columnGenerated = (column: TableColumn) =>
  column.generatedType
    ? `${column.generatedType} AS ${normalizeSqlExpression(column.asExpression)}`
    : column.isGenerated
      ? (column.generationStrategy ?? 'generated')
      : null;

export const recordsFromTables = (
  tables: readonly Table[],
  { checks = false, keyOrder }: RecordOptions = {}
): SchemaRecord[] =>
  tables.flatMap((table): SchemaRecord[] => {
    const keys = (name: string | undefined, columns: string[]) =>
      (name === undefined ? undefined : keyOrder?.get(name)) ?? columns;

    return [
      { kind: 'table', table: table.name },
      ...table.columns.map((column): SchemaRecord => ({
        kind: 'column',
        table: table.name,
        name: column.name,
        type: columnType(column),
        nullable: column.isNullable,
        default: normalizeSqlExpression(column.default),
        primary: column.isPrimary,
        generated: columnGenerated(column),
        unique: column.isUnique,
      })),
      ...table.indices.map((index): SchemaRecord => ({
        kind: 'index',
        table: table.name,
        name: index.name ?? '',
        columns: keys(index.name, index.columnNames),
        unique: index.isUnique,
        where: normalizeSqlExpression(index.where),
      })),
      ...table.uniques.map((unique): SchemaRecord => ({
        kind: 'unique',
        table: table.name,
        name: unique.name ?? '',
        columns: keys(unique.name, unique.columnNames),
      })),
      ...table.foreignKeys.map((foreignKey): SchemaRecord => {
        // Column pairs are sorted: PostgreSQL reports them in no fixed order.
        const pairs = foreignKey.columnNames
          .map((column, index): [string, string] => [
            column,
            foreignKey.referencedColumnNames[index],
          ])
          .sort(([left], [right]) => compareText(left, right));

        return {
          kind: 'foreignKey',
          table: table.name,
          columns: pairs.map(([column]) => column),
          referencedTable: foreignKey.referencedTableName,
          referencedColumns: pairs.map(([, column]) => column),
          onDelete: (foreignKey.onDelete ?? 'NO ACTION').toUpperCase(),
          onUpdate: (foreignKey.onUpdate ?? 'NO ACTION').toUpperCase(),
        };
      }),
      ...(checks ? table.checks : []).map((check): SchemaRecord => ({
        kind: 'check',
        table: table.name,
        name: check.name ?? '',
        expression: normalizeSqlExpression(check.expression) ?? '',
      })),
    ];
  });

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;

const recordId = (record: SchemaRecord) => JSON.stringify(canonical(record));

const driftId = ({ side, record }: DriftRecord) =>
  `${side} ${recordId(record)}`;

const sortKey = ({ side, record }: DriftRecord) =>
  [
    'table' in record ? record.table : '',
    KINDS.indexOf(record.kind),
    'name' in record
      ? record.name
      : 'columns' in record
        ? record.columns.join(',')
        : '',
    side,
  ].join('\u0000');

const compareDrift = (left: DriftRecord, right: DriftRecord) =>
  compareText(sortKey(left), sortKey(right)) ||
  compareText(driftId(left), driftId(right));

// Multiset difference: the items that `others` does not account for.
const subtract = <T, U>(
  items: readonly T[],
  others: readonly U[],
  idOf: (value: T | U) => string
): T[] => {
  const remaining = new Map<string, number>();

  for (const other of others) {
    remaining.set(idOf(other), (remaining.get(idOf(other)) ?? 0) + 1);
  }

  return items.filter((item) => {
    const count = remaining.get(idOf(item)) ?? 0;
    remaining.set(idOf(item), count - 1);
    return count <= 0;
  });
};

export const diffSchemaRecords = (
  migrations: readonly SchemaRecord[],
  entities: readonly SchemaRecord[]
): DriftRecord[] =>
  [
    ...subtract(migrations, entities, recordId).map((record): DriftRecord => ({
      side: 'migrations',
      record,
    })),
    ...subtract(entities, migrations, recordId).map((record): DriftRecord => ({
      side: 'entities',
      record,
    })),
  ].sort(compareDrift);

// Strict in both directions: unlisted drift fails, a listed record that no
// longer drifts fails, and so does any listed record that mentions manga.
export const checkDriftAllowlist = (
  drift: readonly DriftRecord[],
  allowlist: DriftAllowlist
): DriftCheck => ({
  unexpected: subtract(drift, allowlist.records, driftId),
  stale: subtract(allowlist.records, drift, driftId),
  forbidden: allowlist.records.filter((entry) => mentionsManga(entry.record)),
});

export const parseDriftAllowlist = (
  source: string,
  label: string,
  { requireReasons = true } = {}
): DriftAllowlist => {
  const parsed: unknown = JSON.parse(source);

  if (
    !isObject(parsed) ||
    typeof parsed.description !== 'string' ||
    !Array.isArray(parsed.records)
  ) {
    throw new Error(
      `${label} must be an object with a description and a records array.`
    );
  }

  return {
    description: parsed.description,
    records: parsed.records.map((entry: unknown, index) => {
      if (
        !isObject(entry) ||
        !SIDES.includes(entry.side as DriftSide) ||
        !isObject(entry.record) ||
        !KINDS.includes(entry.record.kind as SchemaRecord['kind']) ||
        typeof entry.reason !== 'string'
      ) {
        throw new Error(
          `${label}: records[${index}] needs a reason, a side (migrations or entities) and a schema record.`
        );
      }
      if (requireReasons && entry.reason.trim() === '') {
        throw new Error(
          `${label}: records[${index}] has no reason; explain why the drift is accepted.`
        );
      }

      return {
        reason: entry.reason,
        side: entry.side as DriftSide,
        record: entry.record as SchemaRecord,
      };
    }),
  };
};

export const describeDriftRecord = ({ side, record }: DriftRecord) =>
  `  ${side === 'migrations' ? '-' : '+'} ${side} only: ${JSON.stringify(record)}`;

// Keeps the reasons of entries that still drift. New entries get an empty
// reason, which the check rejects until someone writes one.
export const buildDriftAllowlist = (
  drift: readonly DriftRecord[],
  previous: DriftAllowlist | undefined,
  description: string
): DriftAllowlist => {
  const manga = drift.filter((entry) => mentionsManga(entry.record));
  if (manga.length > 0) {
    throw new Error(
      [
        `Refusing to allowlist ${manga.length} manga drift record(s); fix the migration or entity instead:`,
        ...manga.map(describeDriftRecord),
      ].join('\n')
    );
  }

  const reasons = new Map(
    previous?.records.map((entry): [string, string] => [
      driftId(entry),
      entry.reason,
    ])
  );

  return {
    description,
    records: drift.map(({ side, record }) => ({
      reason: reasons.get(driftId({ side, record })) ?? '',
      side,
      record,
    })),
  };
};

export const formatDriftAllowlist = (allowlist: DriftAllowlist) =>
  `${JSON.stringify(allowlist, null, 2)}\n`;

export const describeDriftCheck = (driver: string, check: DriftCheck) =>
  [
    [
      check.unexpected,
      'schema record(s) differ between the migrations and the entities and are not allowlisted:',
    ] as const,
    [
      check.stale,
      'allowlisted record(s) no longer drift; remove them from the allowlist:',
    ] as const,
    [
      check.forbidden,
      'allowlisted record(s) mention manga; manga drift must be fixed, never allowlisted:',
    ] as const,
  ]
    .filter(([entries]) => entries.length > 0)
    .flatMap(([entries, heading]) => [
      `${driver}: ${entries.length} ${heading}`,
      ...entries.map(describeDriftRecord),
    ])
    .join('\n');

// Executed migrations are listed newest first. Undoing every migration from the
// newest one back to the oldest matching one exercises each matching down()
// and leaves the schema exactly where the matching migrations started.
export const selectRoundTripMigrations = (
  executedNewestFirst: readonly string[],
  pattern: RegExp
) => {
  let oldestMatch = -1;

  executedNewestFirst.forEach((name, index) => {
    if (pattern.test(name)) {
      oldestMatch = index;
    }
  });

  return executedNewestFirst.slice(0, oldestMatch + 1);
};

// Pure helpers for checkMigrationDrift.ts. They compare the statements that
// TypeORM's schema builder would still run after every migration has been
// applied (the same set `migration:generate --check` reports) against a
// reviewed allowlist of drift that already existed before the manga work.

export interface DriftQuery {
  query: string;
  parameters?: unknown[];
}

export interface DriftAllowlist {
  description: string;
  statements: string[];
}

export interface DriftComparison {
  unexpected: string[];
  stale: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const normalizeDriftQuery = ({ query, parameters }: DriftQuery) => {
  const statement = query.replace(/\s+/g, ' ').trim();

  return parameters && parameters.length > 0
    ? `${statement} -- parameters: ${JSON.stringify(parameters)}`
    : statement;
};

const countStatements = (statements: readonly string[]) => {
  const counts = new Map<string, number>();

  for (const statement of statements) {
    counts.set(statement, (counts.get(statement) ?? 0) + 1);
  }

  return counts;
};

const excessStatements = (
  left: Map<string, number>,
  right: Map<string, number>
) => {
  const excess: string[] = [];

  for (const [statement, count] of left) {
    for (let index = right.get(statement) ?? 0; index < count; index += 1) {
      excess.push(statement);
    }
  }

  return excess;
};

// Statements are compared as a multiset: a new statement fails the check, and
// so does an allowlisted statement that no longer appears (a stale entry hides
// nothing, but it must be removed so the allowlist stays reviewable).
export const compareDriftStatements = (
  actual: readonly string[],
  allowed: readonly string[]
): DriftComparison => {
  const actualCounts = countStatements(actual);
  const allowedCounts = countStatements(allowed);

  return {
    unexpected: excessStatements(actualCounts, allowedCounts),
    stale: excessStatements(allowedCounts, actualCounts),
  };
};

export const parseDriftAllowlist = (
  source: string,
  label: string
): DriftAllowlist => {
  const parsed: unknown = JSON.parse(source);

  if (
    !isRecord(parsed) ||
    typeof parsed.description !== 'string' ||
    !Array.isArray(parsed.statements) ||
    !parsed.statements.every((statement) => typeof statement === 'string')
  ) {
    throw new Error(
      `${label} must be an object with a description string and a statements string array.`
    );
  }

  return {
    description: parsed.description,
    statements: parsed.statements as string[],
  };
};

export const formatDriftAllowlist = (allowlist: DriftAllowlist) =>
  `${JSON.stringify(allowlist, null, 2)}\n`;

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

export const describeDriftComparison = (
  driver: string,
  comparison: DriftComparison
) => {
  const lines: string[] = [];

  if (comparison.unexpected.length > 0) {
    lines.push(
      `${driver}: ${comparison.unexpected.length} schema statement(s) are not produced by migrations and are not allowlisted:`,
      ...comparison.unexpected.map((statement) => `  + ${statement}`)
    );
  }

  if (comparison.stale.length > 0) {
    lines.push(
      `${driver}: ${comparison.stale.length} allowlisted statement(s) no longer appear; remove them from the allowlist:`,
      ...comparison.stale.map((statement) => `  - ${statement}`)
    );
  }

  return lines.join('\n');
};

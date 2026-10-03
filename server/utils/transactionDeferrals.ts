import type { QueryRunner } from 'typeorm';

// TypeORM keeps the savepoint depth in a field its types mark protected.
// Without it, an active transaction counts as a single level.
export const getTransactionDepth = (queryRunner: QueryRunner): number => {
  const depth = (queryRunner as unknown as { transactionDepth?: unknown })
    .transactionDepth;
  if (typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0) {
    return depth;
  }
  return queryRunner.isTransactionActive ? 1 : 0;
};

type DeferredEntry<T> = { depth: number; item: T };

// Work that may only run once the outermost transaction has committed.
// TypeORM reports a savepoint release or rollback as a commit or rollback of
// the same query runner while the outer transaction is still active, so each
// item remembers the depth that queued it.
export class TransactionDeferrals<T> {
  private entries = new WeakMap<QueryRunner, DeferredEntry<T>[]>();

  public add(queryRunner: QueryRunner, item: T): void {
    const entries = this.entries.get(queryRunner) ?? [];
    entries.push({ depth: getTransactionDepth(queryRunner), item });
    this.entries.set(queryRunner, entries);
  }

  public some(
    queryRunner: QueryRunner,
    predicate: (item: T) => boolean
  ): boolean {
    return (this.entries.get(queryRunner) ?? []).some(({ item }) =>
      predicate(item)
    );
  }

  // Returns every item once the outermost transaction has committed. A
  // released savepoint hands its items to the enclosing level instead.
  public commit(queryRunner: QueryRunner): T[] {
    const entries = this.entries.get(queryRunner) ?? [];
    if (!queryRunner.isTransactionActive) {
      this.entries.delete(queryRunner);
      return entries.map(({ item }) => item);
    }
    const depth = getTransactionDepth(queryRunner);
    for (const entry of entries) {
      entry.depth = Math.min(entry.depth, depth);
    }
    return [];
  }

  // Returns the discarded items: all of them when the outermost transaction
  // rolls back, otherwise only those queued inside the rolled-back savepoint.
  public rollback(queryRunner: QueryRunner): T[] {
    const entries = this.entries.get(queryRunner) ?? [];
    if (!queryRunner.isTransactionActive) {
      this.entries.delete(queryRunner);
      return entries.map(({ item }) => item);
    }
    const depth = getTransactionDepth(queryRunner);
    this.entries.set(
      queryRunner,
      entries.filter((entry) => entry.depth <= depth)
    );
    return entries
      .filter((entry) => entry.depth > depth)
      .map(({ item }) => item);
  }

  // Removes and returns every item for the query runner. A new outermost
  // transaction calls this for items whose transaction never reported its
  // end, as on SQLite's single shared query runner.
  public discard(queryRunner: QueryRunner): T[] {
    const entries = this.entries.get(queryRunner) ?? [];
    this.entries.delete(queryRunner);
    return entries.map(({ item }) => item);
  }
}

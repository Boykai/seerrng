/** Keep already-rendered search cards in place as infinite scroll adds pages. */
export const stableSearchResults = <T>(
  sortedResults: T[],
  previousIds: readonly string[],
  keyOf: (result: T) => string
): T[] => {
  const byId = new Map(sortedResults.map((result) => [keyOf(result), result]));
  const seen = new Set<string>();
  const stable: T[] = [];

  for (const id of previousIds) {
    const result = byId.get(id);
    if (result && !seen.has(id)) {
      stable.push(result);
      seen.add(id);
    }
  }

  for (const result of sortedResults) {
    const id = keyOf(result);
    if (!seen.has(id)) {
      stable.push(result);
      seen.add(id);
    }
  }

  return stable;
};

/** Splits values into consecutive slices of at most `size` items. */
export const chunk = <T>(values: readonly T[], size: number): T[][] => {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error('Chunk size must be a positive integer.');
  }
  const slices: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    slices.push(values.slice(start, start + size));
  }
  return slices;
};

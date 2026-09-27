/** Provider list titles vary; use the same collection terminology throughout Seerr. */
export const getTvCollectionName = (name: string): string => {
  const base = name
    .trim()
    .replace(/\s+(franchise|collection)$/i, '')
    .trim();
  return base ? `${base} Collection` : 'Collection';
};

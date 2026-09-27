export type SortField =
  | 'relevance'
  | 'title'
  | 'author'
  | 'artist'
  | 'date'
  | 'publisher'
  | 'rating'
  | 'writer'
  | 'director';
export type SortOrder = 'asc' | 'desc';

const defaultSortOrders: Record<SortField, SortOrder> = {
  relevance: 'desc',
  date: 'desc',
  title: 'asc',
  publisher: 'asc',
  author: 'asc',
  artist: 'asc',
  rating: 'desc',
  writer: 'asc',
  director: 'asc',
};

export const getSortField = (
  value: string | string[] | undefined
): SortField =>
  value === 'title' ||
  value === 'relevance' ||
  value === 'author' ||
  value === 'artist' ||
  value === 'date' ||
  value === 'publisher' ||
  value === 'rating' ||
  value === 'writer' ||
  value === 'director'
    ? value
    : 'date';

export const getDefaultSortOrder = (field: SortField): SortOrder =>
  defaultSortOrders[field];

export const getSortOrder = (
  value: string | string[] | undefined,
  field: SortField
): SortOrder =>
  value === 'asc' || value === 'desc' ? value : getDefaultSortOrder(field);

export const getBookSearchRelevance = (
  title: string,
  query: string
): number => {
  const normalize = (value: string) =>
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const normalizedTitle = normalize(title);
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;
  if (normalizedTitle === normalizedQuery) return 3;
  if (normalizedTitle.startsWith(`${normalizedQuery} `)) return 2;
  if (normalizedTitle.includes(normalizedQuery)) return 1;
  return 0;
};

import type { MediaCategoryKey } from '@server/constants/mediaCategories';

export interface ProwlarrSearchResult {
  title: string;
  indexer: string;
  indexerId: number | null;
  size: number | null;
  seeders: number | null;
  leechers: number | null;
  grabs: number | null;
  protocol: string;
  publishDate: string | null;
  infoUrl: string | null;
  categories: { id: number; name: string }[];
}

export interface ProwlarrSearchResultsResponse {
  category: MediaCategoryKey;
  query: string;
  offset: number;
  limit: number;
  results: ProwlarrSearchResult[];
  hasMore: boolean;
}

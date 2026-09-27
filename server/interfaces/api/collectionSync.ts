export interface CollectionDestination {
  libraryId: string;
  libraryName: string;
  state: 'exists' | 'missing' | 'unknown' | 'conflict';
  count: number;
  /** Catalog identities verified as playable in this destination. */
  availableIds?: string[];
  managed: boolean;
  /** Binds confirmation to the verified server, library and remote collection. */
  removalToken?: string;
}

export interface CollectionSyncStatus {
  supported: boolean;
  checkedAt: number;
  destinations: CollectionDestination[];
}

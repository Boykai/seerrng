import type { MediaServerType } from '@server/constants/server';

export interface MediaServerSavedItemStatus {
  serverType: MediaServerType;
  kind: 'watchlist' | 'favorites';
  available: boolean;
  saved?: boolean;
  reason?: 'account-not-linked' | 'series-not-found';
}

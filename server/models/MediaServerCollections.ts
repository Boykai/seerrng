import type { MediaServerType } from '@server/constants/server';
import type { User } from '@server/entity/User';

export interface MediaServerCollectionOption {
  id: string;
  name: string;
  member: boolean;
}

export interface MediaServerCollectionsStatus {
  serverType: MediaServerType;
  available: boolean;
  reason?:
    | 'account-not-linked'
    | 'not-authorized'
    | 'series-not-found'
    | 'unsupported-server'
    | 'collection-limit';
  collections: MediaServerCollectionOption[];
}

/** Trusted server-side context only; never accept account tokens or item IDs from the client. */
export interface MediaServerCollectionContext {
  user: Pick<
    User,
    | 'id'
    | 'plexId'
    | 'plexToken'
    | 'jellyfinUserId'
    | 'jellyfinAuthToken'
    | 'jellyfinDeviceId'
  >;
  tmdbId: number;
  itemId: string;
  is4k: boolean;
}

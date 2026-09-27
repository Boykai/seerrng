import type {
  CollectionDestination,
  CollectionSyncStatus,
} from '@server/interfaces/api/collectionSync';

const destinationItemIds = (
  entry: CollectionDestination,
  includedIds?: string[]
) => {
  if (!entry.availableIds) return [];
  if (!includedIds) return entry.availableIds;
  const included = new Set(includedIds);
  return entry.availableIds.filter((id) => included.has(id));
};

export const availableDestinationCount = (
  entry: CollectionDestination,
  includedIds?: string[]
) =>
  entry.availableIds
    ? destinationItemIds(entry, includedIds).length
    : includedIds === undefined
      ? entry.count
      : 0;

export const availableDestinationIds = (
  entries: CollectionDestination[],
  includedIds?: string[]
) => [
  ...new Set(
    entries.flatMap((entry) => destinationItemIds(entry, includedIds))
  ),
];

const verificationState = (status?: CollectionSyncStatus, error?: unknown) => {
  if (error || (status && !status.supported)) return 'unavailable';
  if (!status) return 'checking';
  if (status.destinations.some((entry) => entry.state === 'unknown'))
    return 'unavailable';
  if (status.destinations.some((entry) => entry.state === 'conflict'))
    return 'conflict';
};
export const collectionAddState = (
  status?: CollectionSyncStatus,
  error?: unknown,
  includedIds?: string[]
) => {
  const verification = verificationState(status, error);
  if (verification) return verification;
  if (
    status?.destinations.some(
      (entry) =>
        entry.state === 'missing' &&
        availableDestinationCount(entry, includedIds) > 0
    )
  )
    return 'ready';
  if (status?.destinations.some((entry) => entry.state === 'exists'))
    return 'exists';
  return 'empty';
};
export const collectionRemoveState = (
  status?: CollectionSyncStatus,
  error?: unknown
) => {
  const verification = verificationState(status, error);
  if (verification) return verification;
  return status?.destinations.some(
    (entry) => entry.state === 'exists' && !!entry.removalToken
  )
    ? 'ready'
    : 'absent';
};

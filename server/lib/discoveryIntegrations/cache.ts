import type DiscoveryAccount from '@server/entity/DiscoveryAccount';
import cacheManager from '@server/lib/cache';
import { createHash } from 'node:crypto';

const flights = new Map<string, Promise<unknown>>();
/** The bounded cache and flight keys contain credential hashes, never credentials. */
export async function cachedAccountRead<T>(
  account: DiscoveryAccount,
  operation: string,
  load: () => Promise<T>,
  ttl = 300
): Promise<T> {
  const key =
    'discovery-account:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          account.provider,
          account.clientId,
          account.accessToken,
          operation,
        ])
      )
      .digest('hex');
  const cache = cacheManager.getCache('trakt').data;
  const cached = cache.get<T>(key);
  if (cached !== undefined) return cached;
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;
  if (flights.size >= 256)
    throw new Error('Too many discovery requests are in progress.');
  const pending = load();
  flights.set(key, pending);
  try {
    const result = await pending;
    cache.set(key, result, ttl);
    return result;
  } finally {
    if (flights.get(key) === pending) flights.delete(key);
  }
}

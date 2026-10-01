import type DiscoveryAccount from '@server/entity/DiscoveryAccount';
import cacheManager from '@server/lib/cache';
import { createHash, randomUUID } from 'node:crypto';

const MAX_TOTAL_DISCOVERY_FLIGHTS = 256;
// Caps how much of the shared flight budget a single discovery account can
// hold at once, so one chatty account cannot starve requests for the rest.
const MAX_DISCOVERY_FLIGHTS_PER_SCOPE = 32;
const flights = new Map<string, Promise<unknown>>();
const flightsPerScope = new Map<string, number>();
const generations = new Map<string, string>();
const accountScope = (account: DiscoveryAccount) =>
  createHash('sha256')
    .update(
      JSON.stringify([account.provider, account.clientId, account.accessToken])
    )
    .digest('hex');
function generation(scope: string) {
  let value = generations.get(scope);
  if (!value) {
    value = randomUUID();
    generations.set(scope, value);
    if (generations.size > 500)
      generations.delete(generations.keys().next().value!);
  }
  return value;
}
export function invalidateAccountReads(account: DiscoveryAccount) {
  const scope = accountScope(account);
  generations.delete(scope);
  generation(scope);
  const cache = cacheManager.getCache('trakt').data;
  cache
    .keys()
    .filter((key) => key.startsWith(`discovery-account:${scope}:`))
    .forEach((key) => cache.del(key));
}
/** The bounded cache and flight keys contain credential hashes, never credentials. */
export async function cachedAccountRead<T>(
  account: DiscoveryAccount,
  operation: string,
  load: () => Promise<T>,
  ttl = 300
): Promise<T> {
  const scope = accountScope(account);
  const revision = generation(scope);
  const key = `discovery-account:${scope}:${revision}:${createHash('sha256').update(operation).digest('hex')}`;
  const cache = cacheManager.getCache('trakt').data;
  const cached = cache.get<T>(key);
  if (cached !== undefined) return cached;
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;
  if ((flightsPerScope.get(scope) ?? 0) >= MAX_DISCOVERY_FLIGHTS_PER_SCOPE) {
    throw new Error(
      'Too many discovery requests are in progress for this account.'
    );
  }
  if (flights.size >= MAX_TOTAL_DISCOVERY_FLIGHTS)
    throw new Error('Too many discovery requests are in progress.');
  const pending = load();
  flights.set(key, pending);
  flightsPerScope.set(scope, (flightsPerScope.get(scope) ?? 0) + 1);
  try {
    const result = await pending;
    if (generations.get(scope) === revision) cache.set(key, result, ttl);
    return result;
  } finally {
    if (flights.get(key) === pending) flights.delete(key);
    const remaining = (flightsPerScope.get(scope) ?? 1) - 1;
    if (remaining <= 0) flightsPerScope.delete(scope);
    else flightsPerScope.set(scope, remaining);
  }
}

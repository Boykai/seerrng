import type DiscoveryAccount from '@server/entity/DiscoveryAccount';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { cachedAccountRead, invalidateAccountReads } from './cache';
const account = {
  provider: 'anilist',
  clientId: 'application',
  accessToken: 'credential-cache-test',
} as DiscoveryAccount;
it('isolates personal reads by credential and coalesces concurrent requests', async () => {
  invalidateAccountReads(account);
  let count = 0;
  const load = async () => {
    count++;
    return 'owned';
  };
  assert.deepEqual(
    await Promise.all([
      cachedAccountRead(account, 'read', load),
      cachedAccountRead(account, 'read', load),
    ]),
    ['owned', 'owned']
  );
  assert.equal(count, 1);
  assert.equal(
    await cachedAccountRead(
      { ...account, accessToken: 'other-person' },
      'read',
      async () => 'other'
    ),
    'other'
  );
});
it('does not let an old in-flight read repopulate a cache after a write', async () => {
  invalidateAccountReads(account);
  let release: (value: string) => void = () => undefined;
  const old = cachedAccountRead(
    account,
    'state',
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      })
  );
  invalidateAccountReads(account);
  assert.equal(
    await cachedAccountRead(account, 'state', async () => 'updated'),
    'updated'
  );
  release('old');
  await old;
  assert.equal(
    await cachedAccountRead(account, 'state', async () => 'should-not-load'),
    'updated'
  );
});

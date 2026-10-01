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

it('bounds one account to its share of the in-flight budget without affecting other accounts', async () => {
  const busyAccount = {
    ...account,
    accessToken: 'busy-account-flight-cap-test',
  } as DiscoveryAccount;
  invalidateAccountReads(busyAccount);
  const releases: (() => void)[] = [];
  const hold = () =>
    new Promise<string>((resolve) => {
      releases.push(() => resolve('held'));
    });

  const admitted = Array.from({ length: 32 }, (_, index) =>
    cachedAccountRead(busyAccount, `op-${index}`, hold)
  );
  await Promise.resolve();

  await assert.rejects(
    cachedAccountRead(busyAccount, 'op-over-budget', hold),
    /Too many discovery requests are in progress for this account/
  );

  const otherAccount = {
    ...account,
    accessToken: 'quiet-account-flight-cap-test',
  } as DiscoveryAccount;
  invalidateAccountReads(otherAccount);
  assert.equal(
    await cachedAccountRead(otherAccount, 'read', async () => 'owned'),
    'owned'
  );

  releases.forEach((release) => release());
  await Promise.all(admitted);

  assert.equal(
    await cachedAccountRead(busyAccount, 'op-after-drain', async () => 'free'),
    'free'
  );
});

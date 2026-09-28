import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import cacheManager from '@server/lib/cache';
import SimklAPI from './index';

describe('Simkl account response caching', () => {
  afterEach(() => {
    mock.restoreAll();
    cacheManager.getCache('simkl').flush();
  });

  it('reuses reads for one account without crossing into another account', async () => {
    cacheManager.getCache('simkl').flush();
    const firstAccount = new SimklAPI({
      clientId: 'shared-client',
      accessToken: 'first-account-token',
    });
    const firstRequest = mock.method(
      (firstAccount as unknown as { rawAxios: AxiosInstance }).rawAxios,
      'get',
      async () => ({ data: { owner: 'first' } })
    );

    assert.deepEqual(await firstAccount.getCatalog('/sync/all-items/shows'), {
      owner: 'first',
    });
    assert.deepEqual(await firstAccount.getCatalog('/sync/all-items/shows'), {
      owner: 'first',
    });
    assert.equal(firstRequest.mock.callCount(), 1);

    const secondAccount = new SimklAPI({
      clientId: 'shared-client',
      accessToken: 'second-account-token',
    });
    const secondRequest = mock.method(
      (secondAccount as unknown as { rawAxios: AxiosInstance }).rawAxios,
      'get',
      async () => ({ data: { owner: 'second' } })
    );

    assert.deepEqual(await secondAccount.getCatalog('/sync/all-items/shows'), {
      owner: 'second',
    });
    assert.equal(secondRequest.mock.callCount(), 1);
  });
});

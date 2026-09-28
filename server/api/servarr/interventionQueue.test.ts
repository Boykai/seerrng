import RadarrAPI from '@server/api/servarr/radarr';
import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
afterEach(() => mock.restoreAll());
function api() {
  const result = new RadarrAPI({
    url: 'http://localhost:7878/api/v3',
    apiKey: 'test',
  });
  return {
    result,
    axios: (result as unknown as { axios: AxiosInstance }).axios,
  };
}
it('reads all bounded queue pages before declaring a complete snapshot', async () => {
  const { result, axios } = api();
  let calls = 0;
  mock.method(axios, 'get', async () => ({
    data: {
      totalRecords: 251,
      records:
        calls++ === 0
          ? Array.from({ length: 250 }, (_, id) => ({ id: id + 1 }))
          : [{ id: 251 }],
    },
  }));
  const items = await result.getInterventionQueue();
  assert.equal(items.length, 251);
  assert.equal(calls, 2);
});
it('refuses partial, repeated, malformed and oversized queues', async () => {
  const { result, axios } = api();
  for (const data of [
    { records: [] },
    { totalRecords: 1, records: [] },
    { totalRecords: 5001, records: [] },
    { totalRecords: 2, records: [{ id: 1 }, { id: 1 }] },
    { totalRecords: 1, records: [{ id: 0 }] },
  ]) {
    const stub = mock.method(axios, 'get', async () => ({ data }));
    await assert.rejects(() => result.getInterventionQueue());
    stub.mock.restore();
  }
});

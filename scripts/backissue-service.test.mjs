import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import { parseArgs, run } from './backissue-service.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

test('the scan command targets the BackIssue scheduled task with only SeerrNG credentials', async () => {
  assert.deepStrictEqual(parseArgs(['scan']), {
    command: 'scan',
    id: undefined,
    options: {},
    help: false,
  });

  let fetchCall;
  globalThis.fetch = async (url, options) => {
    fetchCall = { url, options };
    return new Response(
      JSON.stringify({ id: 'backissue-scan', running: true }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  };
  const log = mock.method(console, 'log', () => undefined);

  const exitCode = await run(['scan'], {
    SEERRNG_URL: 'https://seerr.example.com/base/',
    SEERRNG_API_KEY: 'seerr-admin-key',
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(
    fetchCall.url,
    'https://seerr.example.com/base/api/v1/settings/jobs/backissue-scan/run'
  );
  assert.strictEqual(fetchCall.options.method, 'POST');
  assert.strictEqual(fetchCall.options.headers['X-Api-Key'], 'seerr-admin-key');
  assert.strictEqual(fetchCall.options.body, undefined);
  assert.match(
    log.mock.calls[0].arguments[0],
    /BackIssue collection scan started/
  );
});

test('the scan command rejects unrelated BackIssue service options', () => {
  assert.throws(
    () => parseArgs(['scan', '--sync']),
    /cannot be used with scan/
  );
});

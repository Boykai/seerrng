#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { default: ReadarrAPI } = require('../dist/api/servarr/readarr.js');

const apiUrl = (
  process.env.CHAPTARR_API_URL ?? 'http://chaptarrng:8789/api/v1'
).replace(/\/+$/, '');
const serviceKey = process.env.CHAPTARR_SEERR_API_KEY;
const globalKey = process.env.CHAPTARR_GLOBAL_API_KEY;

if (!serviceKey || !globalKey || serviceKey === globalKey) {
  throw new Error(
    'Set distinct CHAPTARR_SEERR_API_KEY and CHAPTARR_GLOBAL_API_KEY values.'
  );
}

const requestWithKey = (path, key, init = {}) =>
  fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      'X-Api-Key': key,
      ...(init.headers ?? {}),
    },
  });

const api = new ReadarrAPI({
  url: apiUrl,
  apiKey: serviceKey,
  mediaType: 'audiobook',
});

let systemStatus;
let lastError;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  try {
    systemStatus = await api.getSystemStatus();
    break;
  } catch (error) {
    lastError = error;
    await delay(1_500);
  }
}

assert.ok(
  systemStatus,
  `ChaptarrNG did not become available: ${lastError instanceof Error ? lastError.message : 'unknown error'}`
);
assert.equal(systemStatus.appName, 'Chaptarr');

const capabilitiesResponse = await requestWithKey(
  '/system/capabilities',
  serviceKey
);
assert.equal(capabilitiesResponse.status, 200);
const capabilities = await capabilitiesResponse.json();
assert.equal(capabilities.contract, 'chaptarrng-seerr-bookshelf');
assert.equal(capabilities.contractVersion, 1);
assert.equal(capabilities.features?.restrictedServiceApiKey, true);

// This call uses SeerrNG's adapter and follows the advertised format facade
// and paged-library contract using the dedicated service key.
const books = await api.getBooks();
assert.ok(Array.isArray(books));

const administrativeResponse = await requestWithKey('/config/host', serviceKey);
assert.ok(
  [401, 403].includes(administrativeResponse.status),
  `Expected the service key to be rejected by /config/host, got ${administrativeResponse.status}`
);

const unrelatedCommandResponse = await requestWithKey('/command', serviceKey, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'RefreshAuthor', authorIds: [1] }),
});
assert.ok(
  [401, 403].includes(unrelatedCommandResponse.status),
  `Expected the service key to be rejected for unrelated commands, got ${unrelatedCommandResponse.status}`
);

const globalKeyResponse = await requestWithKey('/config/host', globalKey);
assert.equal(globalKeyResponse.status, 200);

console.log(
  `ChaptarrNG ${systemStatus.version} accepted SeerrNG's restricted key for capabilities and the ${books.length}-book paged library; administrative and unrelated command access was denied.`
);

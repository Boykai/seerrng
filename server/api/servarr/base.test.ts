import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_SERVARR_CONFIGURATION_RESULTS,
  MAX_SERVARR_LIBRARY_RESPONSE_BYTES,
  MAX_SERVARR_LIBRARY_RESULTS,
  MAX_SERVARR_QUEUE_RESULTS,
  sanitizeServarrProfiles,
  sanitizeServarrQueue,
  sanitizeServarrRecordArray,
  sanitizeServarrRootFolders,
  sanitizeServarrSystemStatus,
  sanitizeServarrTags,
} from './base';

describe('Servarr response normalization', () => {
  it('keeps full-library response size bounded at 64 MiB', () => {
    assert.equal(MAX_SERVARR_LIBRARY_RESPONSE_BYTES, 64 * 1024 * 1024);
    assert.ok(MAX_SERVARR_LIBRARY_RESPONSE_BYTES > 0);
  });

  it('returns only bounded operational system fields', () => {
    assert.deepStrictEqual(
      sanitizeServarrSystemStatus({
        appName: 'Sonarr',
        version: '4.0.0',
        urlBase: '/sonarr',
        apiKey: 'provider-secret',
        startupPath: '/private/path',
      }),
      { appName: 'Sonarr', version: '4.0.0', urlBase: '/sonarr' }
    );
    assert.throws(
      () => sanitizeServarrSystemStatus({ version: '' }),
      /invalid system status/
    );
  });

  it('caps generic library records and removes malformed entries', () => {
    const records = sanitizeServarrRecordArray([
      null,
      'invalid',
      ...Array.from({ length: MAX_SERVARR_LIBRARY_RESULTS + 100 }, (_, id) => ({
        id,
      })),
    ]);

    assert.strictEqual(records.length, MAX_SERVARR_LIBRARY_RESULTS - 2);
  });

  it('caps and validates configuration collections', () => {
    const records = [
      null,
      { id: 'bad', name: 'Bad' },
      ...Array.from(
        { length: MAX_SERVARR_CONFIGURATION_RESULTS + 100 },
        (_, id) => ({
          id,
          name: `Name ${id}`,
          label: `Tag ${id}`,
          path: `/folder/${id}`,
          unmappedFolders: Array.from(
            { length: MAX_SERVARR_CONFIGURATION_RESULTS + 10 },
            () => ({ name: 'Nested', path: '/nested' })
          ),
          providerOnly: true,
        })
      ),
    ];

    const profiles = sanitizeServarrProfiles(records);
    const folders = sanitizeServarrRootFolders(records);
    const tags = sanitizeServarrTags(records);

    assert.strictEqual(profiles.length, MAX_SERVARR_CONFIGURATION_RESULTS - 2);
    assert.strictEqual(folders.length, MAX_SERVARR_CONFIGURATION_RESULTS - 2);
    assert.strictEqual(tags.length, MAX_SERVARR_CONFIGURATION_RESULTS - 2);
    assert.strictEqual(
      folders[0].unmappedFolders.length,
      MAX_SERVARR_CONFIGURATION_RESULTS
    );
    assert.deepStrictEqual(profiles[0], { id: 0, name: 'Name 0' });
    assert.ok(!('providerOnly' in folders[0]));
  });

  it('caps queue records and bounds common text fields', () => {
    const queue = sanitizeServarrQueue<Record<string, unknown>>([
      null,
      ...Array.from({ length: MAX_SERVARR_QUEUE_RESULTS + 100 }, (_, id) => ({
        id,
        title: 'x'.repeat(20_000),
      })),
    ]);

    assert.strictEqual(queue.length, MAX_SERVARR_QUEUE_RESULTS - 1);
    assert.strictEqual((queue[0].title as string).length, 10_000);
  });
});

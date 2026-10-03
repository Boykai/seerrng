import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import WikidataVideoMetadataAPI from './videoMetadata';

describe('Wikidata video metadata search snippets', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('removes known match markup and preserves other markup as text', async () => {
    (
      mock.method as (
        object: object,
        methodName: string,
        implementation: () => Promise<unknown>
      ) => unknown
    )(ExternalAPI.prototype, 'get', async () => ({
      query: {
        search: [
          {
            title: 'Q123',
            snippet:
              '<span class="searchmatch">Safe title</span> &amp; <script>alert(1)</script>',
          },
        ],
      },
    }));

    const results =
      await new WikidataVideoMetadataAPI().searchItemsByExternalId({
        propertyId: 'P4983',
        value: '123',
      });

    assert.deepStrictEqual(results, [
      {
        id: 'Q123',
        label: 'Safe title &amp; <script>alert(1)</script>',
      },
    ]);
  });
});

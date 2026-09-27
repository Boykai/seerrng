import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('book series request contract', () => {
  it('uses the bulk requester with the series identity, format, and books', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/BookSeriesDetails/index.tsx'),
      'utf8'
    );

    assert.match(source, /<BulkRequestModal/);
    assert.match(source, /mediaType="book"/);
    assert.match(source, /seriesId=\{data\.id\}/);
    assert.match(source, /initialBookFormat=\{requestFormat\}/);
    assert.match(source, /initialItems=\{bulkItems\}/);
    assert.doesNotMatch(source, /<BookRequestModal/);
  });
});

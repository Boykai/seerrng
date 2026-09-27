import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
for (const file of [
  'CollectionDetails/index.tsx',
  'CollectionDetails/CollectionSummaryCard.tsx',
  'TvDetails/SeriesDetailsLayout.tsx',
  'BookDetails/BookDetailsLayout.tsx',
  'MusicDetails/MusicDetailsLayout.tsx',
  'RequestStatus/index.tsx',
  ...['Movie', 'Book', 'Music', 'Collection'].map(
    (type) => `RequestModal/${type}RequestModal.tsx`
  ),
]) {
  test(`${file} puts its poster and summary in the shared inset`, () => {
    assert.match(
      read(`../components/${file}`),
      /(?:refreshed-inset-surface|detail-item-surface) detail-summary-card/
    );
  });
}

test('movie pages and collection members reuse the shared movie summary surface', () => {
  for (const file of [
    'MovieDetails/MovieDetailsLayout.tsx',
    'CollectionDetails/index.tsx',
  ]) {
    assert.match(read(`../components/${file}`), /<MovieSummaryCard/);
  }
  const source = read('../components/MediaDetails/MovieSummaryCard.tsx');
  assert.match(source, /detail-summary-card movie-summary-card/);
  assert.match(source, /detail-item-surface movie-summary-with-ratings/);
  assert.match(source, /refreshed-inset-surface/);
});

test('single-summary list entries do not add an extra inset card', () => {
  for (const file of [
    'Blocklist/index.tsx',
    'Association/AssociationDetailCard.tsx',
    'IssueList/IssueItem/index.tsx',
  ]) {
    const source = read(`../components/${file}`);
    assert.match(source, /refreshed-card-surface/);
    assert.doesNotMatch(source, /refreshed-inset-surface detail-summary-card/);
  }
});

test('issue detail pages retain their inset when sharing a larger container', () => {
  assert.match(
    read('../components/IssueDetails/IssueMediaSummary.tsx'),
    /embedded\s*\?\s*''\s*:\s*'refreshed-inset-surface detail-summary-card'\}\s/
  );
});

test('blocklist source badges explain the method and retain matching tags', () => {
  const source = read('../components/Blocklist/index.tsx');
  assert.match(source, /Someone explicitly blocked this title in Seerr\./);
  assert.match(
    source,
    /content=\{intl.formatMessage\(messages.manualSourceTooltip\)\}/
  );
  const tags = read('../components/BlocklistedTagsBadge/index.tsx');
  assert.match(
    tags,
    /Automatically blocked because this title matched a configured blocked content tag/
  );
  assert.match(tags, /tags: tagNamesBlocklistedFor/);
});

test('blocklist removal is inside the final details column, after Source', () => {
  const source = read('../components/Blocklist/index.tsx');
  const finalColumn = source.slice(
    source.indexOf(
      '<dl className="media-detail-rows refreshed-detail-text media-detail-column-divider'
    )
  );
  const endColumn = finalColumn.indexOf('</dl>');
  assert.ok(
    finalColumn.indexOf('messages.source') <
      finalColumn.indexOf('onClick={() => void removeFromBlocklist()}')
  );
  assert.ok(
    finalColumn.indexOf('onClick={() => void removeFromBlocklist()}') <
      endColumn
  );
  assert.equal(
    (source.match(/onClick=\{\(\) => void removeFromBlocklist\(\)\}/g) ?? [])
      .length,
    1
  );
});

test('summary subcards reuse existing themed surface and inset padding', () => {
  const css = read('./globals.css');
  assert.match(
    css,
    /\.detail-summary-card\s*\{\s*@apply rounded-lg border border-gray-700;/
  );
  assert.match(
    css,
    /\.refreshed-inset-surface,[^{]+\{\s*padding: var\(--inset-card-padding\) !important/
  );
  assert.match(
    read('../components/RequestModal/TvRequestModal.tsx'),
    /refreshed-inset-surface rounded-lg border border-gray-700/
  );
});

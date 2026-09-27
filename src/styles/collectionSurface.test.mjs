import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
test('cast, crew and collection items share the same 30-percent surface', () => {
  const css = read('./globals.css');
  assert.match(
    css,
    /\.detail-item-surface\s*\{\s*@apply rounded-lg border border-gray-700 bg-gray-900\/30;/
  );
  assert.match(
    css,
    /\.detail-item-interactive\s*\{[^}]*hover:bg-indigo-500\/15/
  );
  for (const file of [
    'MediaDetails/ExpandableCreditList.tsx',
    'CollectionDetails/CollectionSummaryCard.tsx',
    'CollectionDetails/index.tsx',
  ]) {
    assert.match(read('../components/' + file), /detail-item-surface/);
  }
});
test('collection disclosure is a single standard subcard with an inline overview', () => {
  const collection = read(
    '../components/CollectionDetails/CollectionSummaryCard.tsx'
  );
  assert.match(
    collection,
    /detail-item-surface detail-summary-card media-detail-collection-card/
  );
  assert.doesNotMatch(
    collection,
    /refreshed-card-surface|refreshed-inset-surface|collection-summary-overview-text/
  );
  assert.match(
    collection,
    /<dd className="collection-summary-overview-value">/
  );
  assert.equal((collection.match(/<section\b/g) ?? []).length, 1);
});

test('media-page overview expands fully and genres occupy the last two rows', () => {
  const css = read('./globals.css');
  const overviewRule = css.match(
    /\.collection-summary-overview-value\s*\{([^}]+)\}/
  )?.[1];
  assert.match(overviewRule, /col-end-\[-1\]/);
  assert.match(overviewRule, /overflow-wrap: anywhere/);
  assert.doesNotMatch(overviewRule, /line-clamp|overflow-hidden|max-height/);
  assert.match(
    css,
    /\.collection-summary-table\s*\{[^}]*grid-template-rows:\s*minmax\(calc\(3 \* var\(--detail-row-height\)\), auto\)\s*repeat\(2, minmax\(var\(--detail-row-height\), auto\)\)/
  );
  assert.match(
    css,
    /\.collection-summary-genres-value\s*\{[^}]*grid-row: 2 \/ 4;/
  );
});

test('collection page overview is inside its first details table, not a separate card', () => {
  const page = read('../components/CollectionDetails/index.tsx');
  const table = page.slice(
    page.indexOf('<dl className="collection-summary-table'),
    page.indexOf(
      '</dl>',
      page.indexOf('<dl className="collection-summary-table')
    )
  );
  assert.match(table, /collection-summary-overview-value/);
  assert.match(table, /data.overview/);
  assert.ok(
    table.indexOf('collection-summary-overview-label') <
      table.indexOf('collection-summary-genres-label')
  );
  assert.equal((page.match(/messages.overview\)/g) ?? []).length, 1);
  assert.match(
    page,
    /detail-item-surface detail-summary-card collection-summary-header/
  );
  assert.match(page, /collection-summary-poster-image/);
});

test('collection and media detail dividers use one global two-pixel width', () => {
  const css = read('./globals.css');
  assert.match(css, /:root\s*\{[^}]*--detail-divider-width: 2px;/);
  assert.match(
    css,
    /\.collection-summary-table::after\s*\{[^}]*width: var\(--detail-divider-width\)/
  );
  assert.match(
    css,
    /\.media-detail-column-divider\s*\{[^}]*border-left-width: var\(--detail-divider-width\)/
  );
  assert.doesNotMatch(css, /\.collection-summary-table::before/);
  assert.doesNotMatch(
    css,
    /\.media-detail-collection-card \.collection-summary-/
  );
});

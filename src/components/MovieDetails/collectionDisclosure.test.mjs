import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import { styleContract } from '../../styles/cssContract.mjs';

const source = readFileSync(
  new URL('./MovieDetailsLayout.tsx', import.meta.url),
  'utf8'
);

test('collection disclosure precedes Cast and its panel follows the controls', () => {
  const button = source.indexOf(
    'label={intl.formatMessage(messages.viewCollection)}'
  );
  const cast = source.indexOf('label={intl.formatMessage(messages.viewCast)}');
  const panel = source.indexOf('{data.collection && showCollection && (');
  const castPanel = source.indexOf('{showCast && (');
  assert.ok(button > 0 && button < cast && cast < panel && panel < castPanel);
  assert.equal((source.match(/<CollectionSummaryCard\b/g) ?? []).length, 1);
});

test('collection uses the shared pin control and resets expansion on movie navigation', () => {
  assert.match(
    source,
    /onPinClick={\(\) => void togglePinned\('collection'\)}/
  );
  assert.match(source, /pinned={pins.collection}/);
  assert.match(source, /setShowCollection\(pins.collection\)/);
  assert.match(source, /\[pins.collection, data.id\]/);
  assert.match(
    source,
    /onClick={\(\) => setShowCollection\(\(open\) => !open\)}/
  );
});

test('collection page and movie summary share the same table placement', () => {
  for (const file of [
    '../CollectionDetails/index.tsx',
    '../CollectionDetails/CollectionSummaryCard.tsx',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(
      source,
      /className="collection-summary-table detail-card-heading-spacing"/
    );
    assert.ok(
      source.indexOf('className="collection-summary-genres-label"') <
        source.indexOf('className="collection-summary-size-label"')
    );
    assert.match(source, /className="collection-summary-genres-value"/);
    assert.match(source, /className="collection-summary-size-value"/);
  }
});

const collectionCss = () =>
  readFileSync(new URL('../../styles/globals.css', import.meta.url), 'utf8');
const assertCollectionLayout = (css) => {
  const contract = styleContract(css);
  const tableRules = contract.rulesFor('.collection-summary-table');
  const rowRules = tableRules.filter((rule) =>
    rule.nodes.some(
      (node) => node.type === 'decl' && node.prop === 'grid-template-rows'
    )
  );
  assert.equal(rowRules.length, 2);
  assert.equal(rowRules[0].parent.name, 'layer');
  assert.equal(rowRules[1].parent.name, 'media');
  assert.equal(rowRules[1].parent.params, '(min-width: 720px)');
  assert.ok(
    contract.applies('.collection-summary-overview-value').has('row-start-1')
  );
  assert.ok(
    contract.applies('.collection-summary-genres-value').has('line-clamp-2')
  );
  assert.ok(
    contract.applies('.collection-summary-genres-value').has('row-start-3')
  );
  assert.ok(
    contract.applies('.collection-summary-genres-value').has('row-span-2')
  );
  assert.match(
    contract.declaration('.collection-summary-table', 'grid-template-rows'),
    /minmax\(calc\(3 \* var\(--detail-row-height\)\), auto\)\s*repeat\(2, minmax\(var\(--detail-row-height\), auto\)\)/
  );
  // The size pair owns its inner two-column grid; the wide table owns three tracks.
  assert.ok(
    contract
      .applies('.collection-summary-size')
      .has('grid-cols-[max-content_minmax(0,1fr)]')
  );
  assert.ok(
    contract.applies('.collection-summary-size-label').has('col-start-1')
  );
  assert.ok(
    contract.applies('.collection-summary-size-value').has('col-start-2')
  );
  assert.equal(
    contract.declaration('.collection-summary-genres-value', 'grid-column'),
    '2'
  );
  assert.equal(
    contract.declaration('.collection-summary-genres-value', 'grid-row'),
    '2 / 4'
  );
  assert.equal(
    contract.declaration('.collection-summary-size', 'grid-column'),
    '3'
  );
  assert.equal(
    contract.declaration('.collection-summary-size', 'grid-row'),
    '2 / 4'
  );
  assert.equal(
    contract.declaration('.collection-summary-table::after', 'grid-column'),
    '3'
  );
  assert.equal(
    contract.declaration('.collection-summary-table::after', 'grid-row'),
    '2 / 4'
  );
  for (const file of [
    '../CollectionDetails/index.tsx',
    '../CollectionDetails/CollectionSummaryCard.tsx',
  ]) {
    const consumer = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(
      consumer,
      /<div className="collection-summary-size">\s*<dt className="collection-summary-size-label">/
    );
  }
};

test('collection table expands its overview and shares responsive genre and size owners', () => {
  assertCollectionLayout(collectionCss());
});

test('collection placement check rejects a size column detached from the divider', () => {
  assert.throws(
    () =>
      assertCollectionLayout(
        collectionCss() + '\n.collection-summary-size { grid-column: 4; }'
      ),
    assert.AssertionError
  );
});

test('Movie Details inherits its divider treatment without an inline override', () => {
  assert.doesNotMatch(source, /--theme-detail-divider-shadow|CSSProperties/);
});

test('black glowing divider overrides are limited to Blackout', () => {
  const css = readFileSync(
    new URL('../../styles/globals.css', import.meta.url),
    'utf8'
  );
  const contract = styleContract(css);
  const palette = "[data-theme-palette='seerr']";
  assert.equal(
    contract.declaration(palette, '--theme-detail-divider-shadow'),
    '0 0 4px 0 rgb(255 255 255 / 0.8)'
  );
  const glowing = [];
  postcss.parse(css).walkDecls('box-shadow', (decl) => {
    if (decl.value === 'var(--theme-detail-divider-shadow)')
      glowing.push(decl.parent);
  });
  assert.equal(glowing.length, 2);
  for (const rule of glowing) {
    for (const selector of rule.selectors) {
      assert.ok(selector.trim().startsWith(palette + ' '));
      assert.equal(contract.declaration(selector, 'background-color'), 'black');
    }
  }
});

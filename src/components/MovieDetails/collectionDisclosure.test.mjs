import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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

test('collection table expands its overview before the final two genre rows', () => {
  const css = readFileSync(
    new URL('../../styles/globals.css', import.meta.url),
    'utf8'
  );
  assert.match(
    css,
    /grid-template-rows:\s*minmax\(calc\(3 \* var\(--detail-row-height\)\), auto\)\s*repeat\(2, minmax\(var\(--detail-row-height\), auto\)\)/
  );
  assert.match(css, /\.collection-summary-genres-value\s*\{[^}]*line-clamp-2/);
  assert.match(
    css,
    /\.collection-summary-genres-value\s*\{\s*grid-column: 2 \/ 5;/
  );
  assert.match(
    css,
    /\.collection-summary-size-label\s*\{\s*grid-column: 5;\s*grid-row: 2;/
  );
  assert.match(
    css,
    /\.collection-summary-size-value\s*\{\s*grid-column: 6;\s*grid-row: 2;/
  );
  assert.match(
    css,
    /\.collection-summary-table::after\s*\{[^}]*grid-row: 2 \/ 4;/
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
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const theme = css.match(
    /\[data-theme-palette='blackout'\]\s*\{([^}]+)\}/
  )?.[1];
  assert.ok(theme);
  assert.match(
    theme,
    /--theme-detail-divider-shadow:\s*0 0 4px 0 rgb\(255 255 255 \/ 0\.8\);/
  );
  assert.doesNotMatch(theme, /0 0 0 1px rgb\(255 255 255\)/);
  const glowing = rules.filter(([, , body]) =>
    body.includes('box-shadow: var(--theme-detail-divider-shadow)')
  );
  assert.equal(glowing.length, 2);
  for (const [, selectors, body] of glowing) {
    for (const selector of selectors.split(',')) {
      assert.ok(selector.trim().startsWith("[data-theme-palette='blackout']"));
    }
    assert.match(body, /background-color: black;/);
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
test('primary action rows fill their width while disclosure rows remain left aligned', () => {
  assert.match(
    css,
    /\.media-primary-action-row\s*\{[^}]*w-full[^}]*justify-between/
  );
  assert.doesNotMatch(
    css.match(/\.media-detail-disclosure-row\s*\{([^}]+)\}/)?.[1] ?? '',
    /justify-between/
  );
  for (const file of [
    'MovieDetails/MovieDetailsLayout.tsx',
    'TvDetails/SeriesDetailsLayout.tsx',
    'BookDetails/BookDetailsLayout.tsx',
    'MusicDetails/MusicDetailsLayout.tsx',
    'CollectionDetails/index.tsx',
  ]) {
    assert.match(
      readFileSync(new URL(`../components/${file}`, import.meta.url), 'utf8'),
      /className="media-primary-action-row"/
    );
  }
});
test('main and inset padding have independent eight-pixel settings', () => {
  assert.match(css, /--card-spacing: 8px;/);
  assert.match(css, /--main-card-padding: 8px;/);
  assert.match(css, /--inset-card-padding: 8px;/);
  assert.match(
    css,
    /\.refreshed-card-surface,[^{]+\{\s*padding: var\(--main-card-padding\) !important/
  );
  assert.match(
    css,
    /\.refreshed-inset-surface,[^{]+\{\s*padding: var\(--inset-card-padding\) !important/
  );
  assert.doesNotMatch(
    css,
    /padding(?:-top)?: var\(--card-spacing\) !important/
  );
});
test('compound settings cards do not double their inset padding', () => {
  for (const selector of [
    'settings-service-card-content',
    'settings-rule-card-content',
  ]) {
    const body = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)`))?.[1];
    assert.ok(body);
    assert.doesNotMatch(body, /\bp-3\b|padding:/);
  }
  assert.match(
    css,
    /padding: var\(--inset-card-padding\) var\(--inset-card-padding\) 0 !important/
  );
});

test('card stacks, inset offsets and Settings grids share the gap token, not padding', () => {
  for (const selector of [
    'card-stack > :not([hidden]) ~ :not([hidden])',
    'card-spacing-before',
    'card-spacing-after',
    'settings-service-grid',
    'settings-library-grid',
  ]) {
    const start = css.indexOf(`.${selector} {`);
    assert.ok(start >= 0, selector);
    const body = css.slice(start, css.indexOf('}', start));
    assert.match(body, /var\(--card-spacing\)/);
  }
  for (const file of [
    '../components/ManageSlideOver/index.tsx',
    '../components/ExternalMediaManageSlideOver/index.tsx',
    '../components/RequestStatus/index.tsx',
    '../components/IssueList/index.tsx',
    '../components/Blocklist/index.tsx',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /card-stack/);
  }
});

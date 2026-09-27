import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
test('ratings keep one empty label cell and span through the second value column', () => {
  assert.match(
    css,
    /\.movie-summary-ratings-empty\s*\{[^}]*grid-column: 1;[^}]*grid-row: 2;/
  );
  assert.match(
    css,
    /\.movie-summary-ratings-values\s*\{[^}]*grid-column: 3 \/ 6;[^}]*grid-row: 2;/
  );
  assert.match(
    css,
    /\.detail-paired-column-span:not\(\.detail-paired-simple-columns\)\s*\{[^}]*grid-template-columns: subgrid;/
  );
});
test('ratings are fully justified within their spanning cell without fixed gaps', () => {
  const rule = css.match(/\.movie-summary-ratings-values\s*\{([^}]+)\}/)?.[1];
  assert.match(rule, /flex flex-wrap items-center justify-between/);
  assert.match(rule, /gap: 0;/);
  assert.doesNotMatch(rule, /justify-start|font-size|width:|height: \d/);
});

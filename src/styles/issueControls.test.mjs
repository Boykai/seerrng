import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
test('Issue Type reuses yellow warning colors without changing other compact selects', () => {
  assert.match(
    css,
    /\.app-button-warning,\s*\.discover-filter-control\.compact-select-warning\s*\{\s*@apply border-yellow-500/
  );
  assert.match(
    css,
    /\.compact-select-warning \.discover-filter-control-label,\s*\.compact-select-warning \.app-filter-select-trigger,\s*\.compact-select-warning \.app-filter-select-chevron\s*\{\s*color: inherit;/
  );
  assert.match(
    css,
    /\.discover-filter-control\.compact-select-warning:focus-within\s*\{\s*@apply border-yellow-300 ring-yellow-500;/
  );
});

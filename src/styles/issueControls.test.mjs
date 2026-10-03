import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { styleContract } from './cssContract.mjs';
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
test('Issue Type reuses yellow warning colors without changing other compact selects', () => {
  const contract = styleContract(css);
  const owner = '.discover-filter-control.compact-select-warning';
  for (const property of ['border-color', 'color']) {
    assert.ok(contract.declaration('.app-button-warning', property));
    assert.equal(
      contract.declaration(owner, property),
      contract.declaration('.app-button-warning', property)
    );
  }
  assert.equal(
    contract.declaration(owner, 'background-color'),
    'hsl(53 100% 10% / 0.35)'
  );
  assert.equal(
    contract.declaration(owner, 'border-color'),
    'color-mix(in srgb, var(--palette-yellow) 90%, transparent)'
  );
  assert.match(
    css,
    /\.compact-select-warning \.discover-filter-control-label,\s*\.compact-select-warning \.app-filter-select-trigger,\s*\.compact-select-warning \.app-filter-select-chevron\s*\{\s*color: inherit;/
  );
  assert.equal(
    contract.declaration(`${owner}:focus-within`, 'border-color'),
    'rgb(253 224 71)'
  );
  assert.equal(
    contract.declaration(`${owner}:focus-within`, '--control-focus-color'),
    'rgb(234 179 8)'
  );
});

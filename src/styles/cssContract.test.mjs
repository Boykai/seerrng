import assert from 'node:assert/strict';
import test from 'node:test';
import { styleContract } from './cssContract.mjs';

test('CSS role contracts follow grouped selectors and separate shared rules', () => {
  const css = styleContract(`
    /* An old source snapshot is not the contract. */
    .card, .dialog { @apply rounded-lg border; }
    .card, .other { @apply bg-gray-900/30; gap: var(--card-spacing); }
  `);
  assert.deepEqual(
    [...css.applies('.card')],
    ['rounded-lg', 'border', 'bg-gray-900/30']
  );
  assert.equal(css.declaration('.card', 'gap'), 'var(--card-spacing)');
  assert.equal(css.declaration('.dialog', 'gap'), undefined);
  assert.equal(css.applies('.missing').size, 0);
});

test('CSS role contracts preserve declaration order and important state', () => {
  const css = styleContract(
    '.card { padding: 8px; } .card { padding: var(--padding) !important; }'
  );
  assert.equal(
    css.declaration('.card', 'padding'),
    'var(--padding) !important'
  );
});

test('CSS role contracts do not confuse descendants, states or comma-bearing functions', () => {
  const css = styleContract(
    '.card:hover { color: red; } .parent .card { color: blue; } :is(.card, .dialog) { color: green; }'
  );
  assert.equal(css.rulesFor('.card').length, 0);
  assert.equal(css.declaration('.card:hover', 'color'), 'red');
  assert.equal(css.declaration(':is(.card, .dialog)', 'color'), 'green');
});

test('CSS role contracts retain changed values and reject invalid stylesheets', () => {
  assert.equal(
    styleContract('.card { gap: 12px; }').declaration('.card', 'gap'),
    '12px'
  );
  assert.throws(() => styleContract('.card { gap: 8px;'), /Unclosed block/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { styleContract } from './cssContract.mjs';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const contract = styleContract(css);

const textEntry =
  "input:where( :not([type]), [type='number'], [type='url'], [type='email'], [type='tel'] )";
const textEntryPlaceholder =
  "input:where( :not([type]), [type='number'], [type='url'], [type='email'], [type='tel'], [type='search'] )::placeholder";
const search = "input:where([type='search'])";
const settingsInput =
  ".settings-page-content input:not([type='checkbox']):not([type='radio'])";

test('untyped, number, url, email and tel inputs use the theme control colors', () => {
  assert.equal(contract.rulesFor(textEntry).length, 1);
  assert.equal(
    contract.declaration(textEntry, 'color'),
    'rgb(var(--theme-control-text))'
  );
  assert.equal(
    contract.declaration(textEntry, 'background-color'),
    'rgb(var(--theme-control-surface) / 0.78)'
  );
  assert.equal(
    contract.declaration(textEntry, 'border-color'),
    'rgb(var(--theme-control-border) / 0.75)'
  );
  const applied = contract.applies(textEntry);
  for (const utility of ['rounded-md', 'border', 'transition', 'sm:text-sm']) {
    assert.ok(applied.has(utility), `${utility} is applied`);
  }
});

test('the text-entry rule leaves layout and owners in control', () => {
  const applied = contract.applies(textEntry);
  for (const utility of ['block', 'w-full', 'flex-1', 'sm:leading-5']) {
    assert.ok(!applied.has(utility), `${utility} is not applied`);
  }
  for (const property of ['display', 'width', 'height', 'padding']) {
    assert.equal(contract.declaration(textEntry, property), undefined);
  }
  // Zero specificity: owner classes and settings rules keep precedence.
  for (const selector of [
    'input:not([type])',
    "input[type='number']",
    "input[type='url']",
    "input[type='search']",
  ]) {
    assert.equal(contract.rulesFor(selector).length, 0, selector);
  }
});

test('text-entry and search placeholders stay readable on the control surface', () => {
  assert.equal(
    contract.declaration(textEntryPlaceholder, 'color'),
    'rgb(var(--theme-control-text) / 0.85)'
  );
  assert.equal(
    contract.declaration(search, 'background-color'),
    'rgb(var(--theme-control-surface) / 0.78)'
  );
  assert.equal(
    contract.declaration(search, 'color'),
    'rgb(var(--theme-control-text))'
  );
  assert.equal(contract.declaration(search, 'border-color'), undefined);
  assert.equal(contract.applies(search).size, 0);
  assert.equal(
    contract.declaration('.app-filter-search-input::placeholder', 'color'),
    'rgb(var(--color-gray-500))'
  );
});

test('typed text inputs and settings inputs keep their own owners', () => {
  const typed = contract.applies("input[type='text']");
  for (const utility of ['block', 'w-full', 'bg-gray-700', 'text-white']) {
    assert.ok(typed.has(utility), `${utility} stays on typed text inputs`);
  }
  assert.equal(
    contract.declaration(settingsInput, 'background-color'),
    'rgb(var(--theme-control-surface) / 0.58) !important'
  );
  assert.equal(
    contract.declaration(settingsInput, 'color'),
    'rgb(var(--theme-control-text)) !important'
  );
});

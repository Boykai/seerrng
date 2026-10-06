import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { styleContract } from './cssContract.mjs';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const contract = styleContract(css);

const textEntry =
  ":where( input:not([type]), input[type='number'], input[type='url'], input[type='email'], input[type='tel'] )";
const textEntryPlaceholder =
  ":where( input:not([type]), input[type='number'], input[type='url'], input[type='email'], input[type='tel'], input[type='search'] )::placeholder";
const search = ":where(input[type='search'])";
const settingsInput =
  ".settings-page-content input:not([type='checkbox']):not([type='radio'])";

const inMedia = (rule, params) =>
  rule.parent?.type === 'atrule' &&
  rule.parent.name === 'media' &&
  rule.parent.params === params;

const baseRules = (selector) =>
  contract.rulesFor(selector).filter((rule) => rule.parent?.name !== 'media');

const declarationIn = (rules, property) =>
  rules
    .flatMap((rule) => rule.nodes)
    .filter((node) => node.type === 'decl' && node.prop === property)
    .at(-1)?.value;

// Removes top-level :where() groups; what remains carries specificity.
const outsideWhere = (selector) => {
  let rest = '';
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    if (depth === 0 && selector.startsWith(':where(', i)) {
      depth = 1;
      i += ':where('.length - 1;
    } else if (depth > 0) {
      if (selector[i] === '(') depth += 1;
      if (selector[i] === ')') depth -= 1;
    } else {
      rest += selector[i];
    }
  }
  return rest.trim();
};

test('untyped, number, url, email and tel inputs use the theme control colors', () => {
  assert.equal(baseRules(textEntry).length, 1);
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
});

test('text-entry inputs share the control border, corner and transition', () => {
  const rules = baseRules(textEntry);
  assert.equal(declarationIn(rules, 'border-width'), '1px');
  assert.equal(declarationIn(rules, 'border-style'), 'solid');
  assert.equal(
    declarationIn(rules, 'border-radius'),
    'var(--control-corner-radius)'
  );
  const transition = declarationIn(rules, 'transition');
  for (const property of [
    'color',
    'background-color',
    'border-color',
    'box-shadow',
  ]) {
    assert.match(
      transition,
      new RegExp(
        `(^|,)\\s*${property} 150ms cubic-bezier\\(0\\.4, 0, 0\\.2, 1\\)`
      ),
      `${property} transitions over 150ms`
    );
  }
  assert.equal(declarationIn(rules, 'font-size'), undefined);
  assert.equal(declarationIn(rules, 'line-height'), undefined);

  const wide = contract
    .rulesFor(textEntry)
    .filter((rule) => inMedia(rule, '(min-width: 640px)'));
  assert.equal(wide.length, 1);
  assert.equal(declarationIn(wide, 'font-size'), 'var(--text-sm)');
  assert.equal(declarationIn(wide, 'line-height'), '1.25rem');
});

test('the text-entry rules are authored CSS with zero specificity and no layout', () => {
  for (const selector of [textEntry, textEntryPlaceholder, search]) {
    const rules = contract.rulesFor(selector);
    assert.ok(rules.length > 0, selector);
    assert.equal(contract.applies(selector).size, 0, `${selector} uses @apply`);
    for (const property of [
      'display',
      'width',
      'flex',
      'height',
      'padding',
      'margin',
    ]) {
      assert.equal(declarationIn(rules, property), undefined, property);
    }
  }
  assert.equal(outsideWhere(textEntry), '');
  assert.equal(outsideWhere(search), '');
  assert.equal(outsideWhere(textEntryPlaceholder), '::placeholder');
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
  assert.equal(
    contract.declaration('.app-filter-search-input::placeholder', 'color'),
    'rgb(var(--color-gray-500))'
  );
});

test('typed text inputs and settings inputs keep their own owners', () => {
  assert.equal(contract.rulesFor("input[type='text']").length, 1);
  assert.equal(contract.rulesFor("input[type='password']").length, 1);
  for (const selector of [textEntry, textEntryPlaceholder, search]) {
    assert.doesNotMatch(selector, /type='(text|password)'/, selector);
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

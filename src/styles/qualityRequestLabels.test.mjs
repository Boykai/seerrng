import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { styleContract } from './cssContract.mjs';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const nativeDeclaration = (contract, selector, property, expected) => {
  const values = contract
    .rulesFor(selector)
    .flatMap((rule) =>
      rule.nodes
        .filter((node) => node.type === 'decl' && node.prop === property)
        .map((node) => `${node.value}${node.important ? ' !important' : ''}`)
    );
  assert.deepEqual(values, [expected], `${selector} owns ${property} once`);
  assert.equal(contract.applies(selector).size, 0, `${selector} is native CSS`);
};
const assertLabels = (source) => {
  const contract = styleContract(source);
  nativeDeclaration(
    contract,
    '.format-request-label',
    'color',
    'rgb(134 239 172)'
  );
  nativeDeclaration(
    contract,
    '.format-request-label',
    'padding-inline',
    'var(--button-padding-x)'
  );
  return contract;
};
const assertDisabledOptions = (source) => {
  const contract = styleContract(source);
  for (const selector of [
    '.format-request-control-single:disabled',
    '.format-request-option:disabled',
  ]) {
    nativeDeclaration(contract, selector, 'cursor', 'not-allowed');
    nativeDeclaration(
      contract,
      selector,
      'background-color',
      'rgb(var(--color-gray-950) / 0.7)'
    );
    nativeDeclaration(
      contract,
      selector,
      'color',
      'rgb(var(--color-gray-500))'
    );
    nativeDeclaration(
      contract,
      selector,
      'filter',
      'brightness(0.5) grayscale(1)'
    );
  }
  // The existing unavailable-quality variant dims its whole control. Its
  // more-specific option rule deliberately preserves green with no extra filter.
  nativeDeclaration(
    contract,
    '.format-request-control.media-quality-unavailable',
    'opacity',
    '0.5'
  );
  const unavailable =
    '.media-quality-unavailable .format-request-option:disabled';
  nativeDeclaration(contract, unavailable, 'background-color', 'transparent');
  nativeDeclaration(contract, unavailable, 'color', 'rgb(187 247 208)');
  nativeDeclaration(contract, unavailable, 'filter', 'none');
  for (const selector of [
    '.format-request-option:hover:not(:disabled)',
    '.format-request-option:active:not(:disabled)',
    ".format-request-option[aria-pressed='true']:not(:disabled)",
  ])
    assert.ok(
      contract.rulesFor(selector).length,
      `${selector} excludes disabled paint`
    );
  for (const selector of [
    '.format-request-option:hover',
    '.format-request-option:active',
    ".format-request-option[aria-pressed='true']",
  ])
    assert.equal(
      contract.rulesFor(selector).length,
      0,
      `${selector} cannot paint disabled controls`
    );
};

test('Quality and Request labels keep the shared green role while action buttons own their semantic green palette', () => {
  const contract = assertLabels(css);
  assert.equal(
    contract.declaration('.app-button-success', 'color'),
    'hsl(119 52% 74%)'
  );
  for (const role of [
    '.app-button-bulk-request',
    '.app-button-detail-request',
  ]) {
    for (const property of ['color', 'border-color', 'background-color']) {
      const expected = contract.declaration('.app-button-success', property);
      assert.ok(expected);
      assert.equal(contract.declaration(role, property), expected);
    }
  }
});

test('disabled format options retain shared grey styling and the unavailable-quality variant', () => {
  assertDisabledOptions(css);
});

test('label check rejects missing green ownership and competing label paint', () => {
  for (const mutant of [
    css.replace('.format-request-label {', '.unrelated-label {'),
    css + '\n.format-request-label { color: white; }',
  ])
    assert.throws(() => assertLabels(mutant), assert.AssertionError);
});

test('disabled check rejects missing owners, changed paint and enabled state leakage', () => {
  for (const mutant of [
    css.replace(
      '.format-request-control-single:disabled,\n  .format-request-option:disabled {',
      '.format-request-control-single:disabled,\n  .unrelated-option:disabled {'
    ),
    css.replace(
      '.format-request-control-single:disabled,',
      '.unrelated-single:disabled,'
    ),
    css.replace('filter: brightness(0.5) grayscale(1);', 'filter: none;'),
    css + '\n.format-request-option:disabled { color: white; }',
    css.replace(
      '.format-request-option:hover:not(:disabled)',
      '.format-request-option:hover'
    ),
    css.replace(
      '.media-quality-unavailable .format-request-option:disabled',
      '.unrelated-quality .format-request-option:disabled'
    ),
  ])
    assert.throws(() => assertDisabledOptions(mutant), assert.AssertionError);
});

test('format controls attach native label and disabled option roles in both option branches', () => {
  const control = readFileSync(
    new URL(
      '../components/Common/FormatRequestControl/index.tsx',
      import.meta.url
    ),
    'utf8'
  );
  assert.match(control, /className="format-request-label"/);
  assert.match(
    control,
    /className={`format-request-control format-request-control-single/
  );
  assert.match(control, /className="format-request-option"/);
  assert.equal(
    (control.match(/disabled=\{option.disabled\}/g) ?? []).length,
    2
  );
});

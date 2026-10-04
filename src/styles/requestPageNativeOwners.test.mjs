import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import ts from 'typescript';

const requester = readFileSync(
  new URL(
    '../components/RequestModal/AdvancedRequester/index.tsx',
    import.meta.url
  ),
  'utf8'
);
const pagination = readFileSync(
  new URL('../components/Common/PaginationFooter/index.tsx', import.meta.url),
  'utf8'
);
const stylesheet = readFileSync(
  new URL('./globals.css', import.meta.url),
  'utf8'
);
const parse = (source) =>
  ts.createSourceFile(
    'requests.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
const collect = (root, predicate) => {
  const nodes = [];
  const visit = (node) => {
    if (predicate(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
};
const attribute = (node, name) =>
  node.attributes.properties.find(
    (item) => ts.isJsxAttribute(item) && item.name.getText() === name
  );
const value = (node, name) => {
  const initializer = attribute(node, name)?.initializer;
  return (
    initializer &&
    (ts.isJsxExpression(initializer)
      ? initializer.expression?.getText()
      : initializer.text)
  );
};
const openings = (source) =>
  collect(
    parse(source),
    (node) => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
  );
const role = (node, name) => value(node, 'className')?.includes(name);
const directSpans = (opening) =>
  opening.parent.children
    .filter(
      (node) =>
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText() === 'span'
    )
    .map((node) => node.openingElement);
const noInlineGeometry = (node) => {
  const style = attribute(node, 'style');
  assert.equal(
    style
      ? collect(
          style,
          (item) =>
            ts.isPropertyAssignment(item) &&
            /^(width|height|minWidth|minHeight|maxWidth|maxHeight)$/.test(
              item.name.getText().replace(/['"]/g, '')
            )
        ).length
      : 0,
    0,
    'native role must not compete with inline geometry'
  );
};
const verifyListboxConsumers = (source) => {
  const nodes = openings(source);
  const controls = nodes.filter(
    (node) =>
      node.tagName.getText() === 'Listbox' &&
      role(node, 'request-listbox-control')
  );
  const buttons = nodes.filter(
    (node) =>
      node.tagName.getText() === 'Listbox.Button' &&
      role(node, 'request-listbox-button')
  );
  const menus = nodes.filter(
    (node) =>
      node.tagName.getText() === 'Listbox.Options' &&
      role(node, 'request-listbox-menu')
  );
  const options = nodes.filter(
    (node) =>
      node.tagName.getText() === 'div' && role(node, 'request-listbox-option')
  );
  for (const group of [controls, buttons, menus, options])
    assert.equal(
      group.length,
      2,
      'both shared and requested-by portal branches retain semantic owners'
    );
  for (const node of [...controls, ...buttons, ...menus, ...options])
    noInlineGeometry(node);
  for (const node of controls) {
    assert(
      attribute(node, 'value') && attribute(node, 'onChange'),
      'Headless UI value and callbacks remain bound'
    );
    assert.equal(
      value(node, 'className'),
      'request-listbox-control',
      'control geometry has one native owner'
    );
  }
  assert.equal(
    value(controls[0], 'disabled'),
    'disabled',
    'exported listbox keeps the disabled callback binding'
  );
  assert.deepEqual(
    menus.map((node) => value(node, 'anchor')),
    ['bottom start', 'top end'],
    'existing portal placement is unchanged'
  );
  for (const node of menus) {
    assert(
      attribute(node, 'portal') && !attribute(node, 'portal').initializer,
      'options retain the portal'
    );
    assert.equal(value(node, 'modal'), 'false', 'options remain nonmodal');
  }
  for (const node of buttons) {
    const spans = directSpans(node);
    assert.equal(
      spans.length,
      1,
      'value remains a direct span for native truncation'
    );
    assert(
      !attribute(spans[0], 'className'),
      'value span must not restore Tailwind truncation owners'
    );
    noInlineGeometry(spans[0]);
  }
  for (const node of options) {
    assert.equal(
      value(node, 'data-selected'),
      'selected',
      'Headless UI selection feeds parent semantic state'
    );
    const classExpression = value(node, 'className');
    assert(
      classExpression.includes('request-listbox-option-active') &&
        /(?:optionActive|active)\s*\?/.test(classExpression),
      'Headless UI active state keeps its semantic owner'
    );
    const spans = directSpans(node);
    assert.equal(spans.length, 1, 'option text remains a direct span');
    assert(
      !attribute(spans[0], 'className'),
      'option span must not restore competing utility emphasis'
    );
    noInlineGeometry(spans[0]);
  }
};
const cssRules = (source) => {
  const root = postcss.parse(source);
  const rules = [];
  root.walkRules((rule) => rules.push(rule));
  return rules;
};
const declarations = (rules, selector, property) =>
  rules
    .filter((rule) => rule.selectors.includes(selector))
    .flatMap((rule) =>
      rule.nodes
        .filter((node) => node.type === 'decl' && node.prop === property)
        .map((node) => node.value)
    );
const ownedRules = (rules) =>
  rules.filter((rule) =>
    /\.request-listbox-[\w-]+\b|\.pagination-footer-page\b(?!-)/.test(
      rule.selector
    )
  );
const verifyNativeCSS = (source) => {
  const rules = cssRules(source);
  for (const rule of ownedRules(rules)) {
    rule.walkAtRules('apply', () =>
      assert.fail(
        'listbox and page indicator roles must be authored native CSS'
      )
    );
    rule.walkDecls((decl) =>
      assert(
        !decl.prop.startsWith('--tw-') && !decl.value.includes('--tw-'),
        'native focus/geometry must not depend on Tailwind internals'
      )
    );
  }
  for (const selector of [
    '.request-listbox-button > span',
    '.request-listbox-option > span',
  ]) {
    assert.deepEqual(
      declarations(rules, selector, 'overflow'),
      ['hidden'],
      'direct spans retain native clipping'
    );
    assert.deepEqual(
      declarations(rules, selector, 'white-space'),
      ['nowrap'],
      'direct spans retain native single-line text'
    );
  }
  assert.deepEqual(
    declarations(rules, '.request-listbox-option > span', 'font-weight'),
    ['var(--card-table-value-weight)'],
    'ordinary options consume the value weight'
  );
  const selectedWeights = rules
    .filter((rule) =>
      /\.request-listbox-option\[data-selected=['"]true['"]\]\s*>\s*span/.test(
        rule.selector
      )
    )
    .flatMap((rule) =>
      rule.nodes
        .filter((node) => node.type === 'decl' && node.prop === 'font-weight')
        .map((node) => node.value)
    );
  assert.deepEqual(
    selectedWeights,
    ['var(--card-table-heading-weight)'],
    'selected option text must have a native emphasis owner'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-control:focus-within', 'box-shadow'),
    ['inset 0 0 0 2px var(--request-listbox-focus-color)'],
    'native focus follows its palette owner'
  );
  assert.deepEqual(
    declarations(
      rules,
      '.request-status-action-row .request-listbox-control',
      '--request-listbox-focus-color'
    ),
    ['var(--palette-green)'],
    'action focus retains its green palette'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-button:disabled', 'cursor'),
    ['not-allowed'],
    'disabled state retains its native cursor'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-button:disabled', 'opacity'),
    ['0.6'],
    'disabled state retains its native opacity'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-label-active', 'background-color'),
    ['rgb(var(--color-indigo-500) / 0.35)'],
    'active label retains its native palette'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-option-active', 'background-color'),
    ['rgb(var(--color-indigo-600))'],
    'active option retains its native palette'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-menu', '--anchor-gap'),
    ['4px'],
    'portal keeps the established anchor gap'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-menu', '--anchor-padding'),
    ['8px'],
    'portal keeps its viewport inset'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-menu', '--filter-option-height'),
    ['1.5rem'],
    'portal option height stays shared'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-menu', '--anchor-max-height'),
    ['calc(8 * var(--filter-option-height) + 0.5rem + 2px)'],
    'portal keeps its eight-option bound'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-menu', 'background-color'),
    ['rgb(var(--theme-control-surface) / 0.98)'],
    'portal surface retains the existing theme opacity'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-menu', 'border-color'),
    ['rgb(var(--theme-control-border) / 0.75)'],
    'portal border retains its theme palette'
  );
  assert.deepEqual(
    declarations(
      rules,
      '.request-listbox-control',
      '--request-listbox-focus-color'
    ),
    ['rgb(var(--color-indigo-400))'],
    'form focus retains its indigo palette'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-option > span', 'display'),
    ['block'],
    'option span owns native block layout'
  );
  for (const role of [
    '.request-listbox-control',
    '.request-listbox-button',
    '.request-listbox-menu',
  ]) {
    assert.equal(
      declarations(rules, role, 'height').length > 1,
      false,
      'native control must not duplicate height declarations'
    );
    assert.equal(
      declarations(rules, role, 'max-width').length > 1,
      false,
      'native control must not duplicate width bounds'
    );
  }
  assert.deepEqual(
    declarations(rules, '.request-listbox-button', 'row-gap'),
    ['var(--button-content-gap)'],
    'button spacing follows the existing shared token'
  );

  assert.deepEqual(
    declarations(rules, '.request-listbox-control', 'height'),
    ['var(--action-control-height)'],
    'dropdown consumes the shared action-height token once'
  );
  assert.deepEqual(
    declarations(
      rules,
      '.request-status-action-row .request-listbox-control',
      'height'
    ),
    ['var(--action-control-height)'],
    'request action keeps the 16px variant'
  );
  assert.deepEqual(
    declarations(rules, '.request-listbox-button', 'max-width'),
    ['min(24rem, 55vw)'],
    'button retains bounded width'
  );
  for (const [property, expected] of [
    ['min-width', 'var(--button-width)'],
    ['max-width', 'min(24rem, calc(100vw - 16px))'],
    ['max-height', 'var(--anchor-max-height)'],
  ]) {
    assert.deepEqual(
      declarations(rules, '.request-listbox-menu', property),
      [expected],
      `portal ${property} retains its single geometry owner`
    );
  }
  const values = declarations(
    rules,
    '.request-listbox-button > span',
    'text-overflow'
  );
  assert.deepEqual(values, ['ellipsis'], 'direct value span owns truncation');
  assert.deepEqual(
    declarations(rules, '.request-listbox-option > span', 'text-overflow'),
    ['ellipsis'],
    'direct option span owns truncation'
  );
  const selectedRules = rules.filter((rule) =>
    /\.request-listbox-option\[data-selected=['"]true['"]\]\s*>\s*span/.test(
      rule.selector
    )
  );
  assert(
    selectedRules.some((rule) =>
      rule.nodes.some(
        (node) => node.type === 'decl' && node.prop === 'font-weight'
      )
    ),
    'selected option text must have a native emphasis owner'
  );
  assert(
    declarations(rules, '.request-listbox-option-active', 'background-color')
      .length > 0,
    'active option retains native background state'
  );
  assert(
    rules.some(
      (rule) =>
        /\.request-listbox-(?:control|button).*:focus-(?:within|visible)/.test(
          rule.selector
        ) &&
        rule.nodes.some(
          (node) =>
            node.type === 'decl' &&
            ['outline', 'box-shadow'].includes(node.prop)
        )
    ),
    'keyboard focus must remain visible in native CSS'
  );
  assert(
    rules.some(
      (rule) =>
        rule.selectors.includes('.request-listbox-button:disabled') &&
        rule.nodes.some(
          (node) => node.type === 'decl' && node.prop === 'opacity'
        )
    ),
    'disabled native state must remain visible'
  );
  const paletteDeclarations = ownedRules(rules).flatMap((rule) =>
    rule.nodes.filter(
      (node) =>
        node.type === 'decl' &&
        /^(?:color|background-color|border-color)$/.test(node.prop)
    )
  );
  assert(
    paletteDeclarations.some((decl) =>
      decl.value.includes('--theme-control-')
    ) &&
      paletteDeclarations.some((decl) =>
        decl.value.includes('--palette-green')
      ),
    'shared dropdown and request action variant keep palette authority'
  );
};
const verifyReducedMotion = (source) => {
  const rules = cssRules(source).filter((rule) => {
    if (!rule.selector.includes('.request-listbox-menu')) return false;
    for (let parent = rule.parent; parent; parent = parent.parent)
      if (
        parent.type === 'atrule' &&
        parent.name === 'media' &&
        /prefers-reduced-motion:\s*reduce/.test(parent.params)
      )
        return true;
    return false;
  });
  assert(rules.length > 0, 'listbox menu retains reduced-motion ownership');
  for (const [property, expected] of [
    ['animation', 'none'],
    ['transition-duration', '0ms'],
  ])
    assert.deepEqual(
      rules.flatMap((rule) =>
        rule.nodes
          .filter((node) => node.type === 'decl' && node.prop === property)
          .map((node) => node.value)
      ),
      [expected],
      'reduced-motion menu disables animation and transition'
    );
};
const verifyPagination = (cssSource, componentSource) => {
  const indicator = openings(componentSource).filter(
    (node) =>
      role(node, 'pagination-footer-page') &&
      !role(node, 'pagination-footer-page-size')
  );
  assert.equal(indicator.length, 1, 'page indicator keeps its native role');
  assert.equal(
    value(indicator[0], 'className'),
    'pagination-footer-page',
    'page indicator does not duplicate utility typography'
  );
  noInlineGeometry(indicator[0]);
  const rules = cssRules(cssSource);
  for (const [property, expected] of [
    ['font-size', 'var(--card-table-font-size)'],
    ['font-weight', 'var(--card-table-heading-weight)'],
    ['line-height', 'var(--detail-row-height)'],
  ]) {
    assert.deepEqual(
      declarations(rules, '.pagination-footer-page', property),
      [expected],
      `pagination ${property} follows CSS authority`
    );
  }
};

test('shared and requested-by listboxes consume native semantic states without utility geometry', () =>
  verifyListboxConsumers(requester));
test('listbox family retains native focus, selection, disabled and portal geometry owners', () => {
  verifyNativeCSS(stylesheet);
  verifyReducedMotion(stylesheet);
});
test('pagination page typography consumes shared table and row tokens', () =>
  verifyPagination(stylesheet, pagination));
test('consumer negatives reject lost selection, utilities and duplicate inline geometry', () => {
  assert.throws(
    () =>
      verifyListboxConsumers(
        requester.replace(/data-selected=\{selected\}/, '')
      ),
    /selection feeds/
  );
  assert.throws(
    () =>
      verifyListboxConsumers(
        requester.replace(
          '<span>{selectedLabel}',
          '<span className="truncate">{selectedLabel}'
        )
      ),
    /Tailwind truncation/
  );
  assert.throws(
    () =>
      verifyListboxConsumers(
        requester.replace(
          'className="request-listbox-button"',
          'className="request-listbox-button" style={{ width: 300 }}'
        )
      ),
    /inline geometry/
  );
});
test('CSS negatives reject retired apply, missing semantic state and competing geometry', () => {
  assert.throws(
    () =>
      verifyNativeCSS(
        `${stylesheet}\n.request-listbox-button { @apply truncate; }`
      ),
    /authored native CSS/
  );
  const missingSelection = postcss.parse(stylesheet);
  missingSelection.walkRules((rule) => {
    if (
      /\.request-listbox-option\[data-selected=['"]true['"]\]\s*>\s*span/.test(
        rule.selector
      )
    )
      rule.remove();
  });
  assert.throws(
    () => verifyNativeCSS(missingSelection.toString()),
    /native emphasis/
  );
  assert.throws(
    () =>
      verifyNativeCSS(
        `${stylesheet}\n.request-listbox-menu { max-width: 30rem; }`
      ),
    /single geometry owner|duplicate width bounds/
  );
  assert.throws(
    () =>
      verifyNativeCSS(
        `${stylesheet}\n.request-listbox-control { --tw-ring-color: red; }`
      ),
    /Tailwind internals/
  );
  const missingMotion = postcss.parse(stylesheet);
  missingMotion.walkAtRules('media', (media) => {
    if (/prefers-reduced-motion:\s*reduce/.test(media.params))
      media.walkRules((rule) => {
        if (rule.selector.includes('.request-listbox-menu')) rule.remove();
      });
  });
  assert.throws(
    () => verifyReducedMotion(missingMotion.toString()),
    /reduced-motion ownership/
  );
  assert.throws(
    () =>
      verifyReducedMotion(
        `${stylesheet}\n@media (prefers-reduced-motion: reduce) { .request-listbox-menu { transition-duration: 150ms; } }`
      ),
    /disables animation and transition/
  );
});

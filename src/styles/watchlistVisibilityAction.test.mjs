import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { styleContract } from './cssContract.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('./globals.css');
const button = read('../components/Common/Button/index.tsx');
const source = read('../components/Discover/DiscoverTv/index.tsx');

function verifyPalette(text) {
  const contract = styleContract(text);
  for (const state of ['', ':hover', ':active']) {
    for (const property of ['border-color', 'background-color', 'color']) {
      const own = contract.declaration('.app-button-warning' + state, property);
      assert.ok(own, 'Yellow action has an authored ' + property);
      assert.equal(
        own,
        contract.declaration('.app-button-report-issue' + state, property)
      );
    }
  }
  assert.equal(
    contract.declaration('.app-button-warning:focus', '--tw-ring-color'),
    'var(--palette-yellow)'
  );
  assert.equal(
    contract.declaration('.app-button-warning:focus', 'border-color'),
    'color-mix(in srgb, var(--palette-yellow) 65%, white)'
  );
  for (const state of ['', ':hover', ':focus', ':active']) {
    for (const rule of contract.rulesFor('.app-button-warning' + state)) {
      rule.walkAtRules('apply', () => assert.fail('Action palette is native'));
    }
  }
}

function actionContract(text) {
  const tree = ts.createSourceFile(
    'action.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const buttons = [];
  function visit(node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(tree) === 'Button'
    )
      buttons.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const action = buttons.find((node) =>
    node.openingElement.attributes.properties.some(
      (p) => ts.isJsxAttribute(p) && p.name.getText(tree) === 'aria-pressed'
    )
  );
  assert.ok(action, 'Stateful action is present');
  const attrs = new Map(
    action.openingElement.attributes.properties
      .filter(ts.isJsxAttribute)
      .map((p) => [p.name.getText(tree), p.initializer])
  );
  assert.equal(attrs.get('buttonType')?.text, 'warning');
  assert.ok(
    !attrs.has('className'),
    'Caller does not override shared action styling'
  );
  const state = attrs.get('aria-pressed')?.expression?.getText(tree);
  assert.ok(state, 'Toggle exposes current state');
  const iconBranch = action.children
    .filter(ts.isJsxExpression)
    .map((n) => n.expression)
    .find((n) => n && ts.isConditionalExpression(n));
  assert.ok(iconBranch, 'Both offered actions have an icon');
  assert.equal(iconBranch.condition.getText(tree), state);
  const unparen = (node) =>
    ts.isParenthesizedExpression(node) ? unparen(node.expression) : node;
  assert.equal(unparen(iconBranch.whenTrue).tagName.getText(tree), 'StarIcon');
  assert.equal(
    unparen(iconBranch.whenFalse).tagName.getText(tree),
    'StarSlashIcon'
  );
  assert.ok(attrs.has('onClick'), 'Existing state toggle remains wired');
}

test('visibility action consumes the established Yellow palette and state owners', () =>
  verifyPalette(css));
test('palette checks reject detached focus or missing state ownership', () => {
  assert.throws(
    () =>
      verifyPalette(
        css.replace(
          '--tw-ring-color: var(--palette-yellow);',
          '--tw-ring-color: var(--palette-green);'
        )
      ),
    { name: 'AssertionError' }
  );
  assert.throws(
    () =>
      verifyPalette(
        css.replace('.app-button-warning:active,', '.unrelated-action:active,')
      ),
    { name: 'AssertionError' }
  );
});
test('stateful visibility action connects shared color and complementary icons to the same state', () => {
  actionContract(source);
  assert.match(button, /warning:\s*'app-button-warning'/);
  assert.match(
    button,
    /'app-button'[\s\S]*buttonTypeStyles\[buttonType\][\s\S]*buttonSizeStyles\[buttonSize\]/
  );
  const icon = read('../components/Common/StarSlashIcon.tsx');
  assert.match(icon, /aria-hidden="true"/);
  assert.doesNotMatch(icon, /className=|style=|width=|height=/);
});
test('stateful action checks reject missing palette or reversed icon states', () => {
  assert.throws(
    () =>
      actionContract(
        source.replace('buttonType="warning"', 'buttonType="default"')
      ),
    { name: 'AssertionError' }
  );
  assert.throws(
    () => actionContract(source.replace('<StarSlashIcon />', '<StarIcon />')),
    { name: 'AssertionError' }
  );
});

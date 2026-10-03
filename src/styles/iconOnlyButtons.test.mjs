import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import ts from 'typescript';
import { auditTailwindClassExpressions } from './tailwindClassVerifier.mjs';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

// The former zero-padding/24px ghost-button trial is superseded by the shared
// five-pixel padding and poster-control contract. Preserve meaningful coverage.
const verifyIconGeometry = (stylesheet) => {
  const root = postcss.parse(stylesheet);
  const declarations = (selector) => {
    const values = new Map();
    root.walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      for (const decl of rule.nodes ?? []) {
        if (decl.type !== 'decl') continue;
        assert.ok(
          !values.has(decl.prop),
          `${selector} ${decl.prop} duplicated`
        );
        values.set(decl.prop, decl.value.replace(/\s+/g, ' '));
      }
    });
    return values;
  };
  const button = declarations('.app-button.app-button-icon-only');
  const width =
    'calc( var(--action-control-content-height) + 2 * var(--button-padding-x) + 2px )';
  assert.equal(button.get('width'), width);
  assert.equal(button.get('min-width'), width);
  assert.equal(button.get('padding-block'), '0');
  assert.equal(
    button.get('padding-inline'),
    'var(--button-padding-x)',
    'icon-only padding retains the shared horizontal owner'
  );
  assert.equal(button.has('padding'), false);
  assert.equal(button.get('flex-shrink'), '0');
  const icon = declarations('.app-button.app-button-icon-only svg');
  assert.equal(icon.get('width'), 'var(--action-control-content-height)');
  assert.equal(icon.get('height'), 'var(--action-control-content-height)');
  assert.equal(icon.get('margin'), '0');
  assert.equal(icon.get('flex-shrink'), '0');
};

const posterSource = readFileSync(
  new URL('../components/TitleCard/index.tsx', import.meta.url),
  'utf8'
);
const verifyPosterBlocklist = (source) => {
  const ast = ts.createSourceFile(
    'TitleCard.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const actions = [];
  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const attrs = node.openingElement.attributes.properties;
      const className = attrs.find(
        (attr) =>
          ts.isJsxAttribute(attr) && attr.name.getText(ast) === 'className'
      );
      if (
        className?.initializer &&
        ts.isStringLiteral(className.initializer) &&
        className.initializer.text
          .split(/\s+/)
          .includes('poster-control-blocklist')
      ) {
        actions.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(actions.length, 1, 'one shared poster blocklist action');
  const action = actions[0];
  const attrs = action.openingElement.attributes.properties;
  const attr = (name) =>
    attrs.find(
      (value) => ts.isJsxAttribute(value) && value.name.getText(ast) === name
    );
  assert.equal(action.openingElement.tagName.getText(ast), 'button');
  assert.match(attr('className').initializer.text, /\bposter-control\b/);
  for (const name of [
    'aria-label',
    'aria-pressed',
    'disabled',
    'onClick',
    'onKeyDown',
  ]) {
    assert.ok(attr(name)?.initializer, `${name} retains its functional owner`);
  }
  assert.match(action.getText(ast), /<EyeIcon aria-hidden="true"/);
  assert.match(action.getText(ast), /<EyeSlashIcon aria-hidden="true"/);
  assert.equal(
    auditTailwindClassExpressions({
      path: 'PosterAction.tsx',
      source: action.getText(ast),
    }).utilities.length,
    0
  );
};

test('shared icon-only buttons retain role-owned width, padding and icon dimensions', () => {
  verifyIconGeometry(css);
});

test('shared media poster blocklist action retains semantic geometry and accessible state', () => {
  verifyPosterBlocklist(posterSource);
});

test('icon and poster checks reject padding drift, missing labels and missing state', () => {
  assert.throws(
    () =>
      verifyIconGeometry(
        `${css}\n.app-button.app-button-icon-only { padding-inline: 0; }`
      ),
    /\.app-button\.app-button-icon-only padding-inline duplicated/
  );
  for (const name of ['aria-label', 'aria-pressed', 'disabled']) {
    const broken = posterSource.replace(
      new RegExp(`(${name})(?==)`),
      `data-invalid-${name}`
    );
    assert.notEqual(broken, posterSource);
    assert.throws(
      () => verifyPosterBlocklist(broken),
      new RegExp(`${name} retains its functional owner`)
    );
  }
});

test('icon geometry rejects a wrong padding value even with only one property owner', () => {
  const root = postcss.parse(css);
  let replacements = 0;
  root.walkRules((rule) => {
    if (!rule.selectors.includes('.app-button.app-button-icon-only')) return;
    rule.walkDecls('padding-inline', (decl) => {
      decl.value = '0';
      replacements++;
    });
  });
  assert.equal(replacements, 1, 'fixture replaces the single padding owner');
  assert.throws(
    () => verifyIconGeometry(root.toString()),
    /icon-only padding retains the shared horizontal owner/
  );
});

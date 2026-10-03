import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';

const css = postcss.parse(
  fs.readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
);
const declaration = (rule, property) =>
  rule.nodes.find((node) => node.type === 'decl' && node.prop === property)
    ?.value;
const rules = [];
css.walkRules((rule) => rules.push(rule));
const owner = (selector) =>
  rules.find(
    (rule) =>
      (rule.selector === selector && rule.parent.type !== 'atrule') ||
      (rule.selector === selector && rule.parent.name === 'layer')
  );
const layout = owner('.request-selection-layout');
const standard = owner(".card-list[data-list-width='two-thirds']");

test('request tree retains the established proportional width and gives its companion the remainder', () => {
  assert.equal(
    declaration(layout, 'grid-template-columns'),
    `${declaration(standard, '--card-list-width')} minmax(0, 1fr)`
  );
  assert.equal(declaration(layout, 'gap'), 'var(--card-spacing)');
  assert.equal(declaration(owner('.request-episode-queue'), 'width'), '100%');
  assert.equal(
    declaration(owner('.request-selection-options'), 'min-width'),
    '0'
  );
  for (const property of ['width', 'max-width', 'height'])
    assert.equal(
      declaration(owner('.request-selection-options'), property),
      undefined
    );
  assert.equal(
    declaration(owner('.selection-tree'), '--scroll-viewport-height'),
    '186px'
  );
});

test('companion card stretches to the selection frame without copying its height', () => {
  assert.equal(
    declaration(owner('.request-selection-options'), 'align-self'),
    'stretch'
  );
  assert.equal(declaration(owner('.request-episode-queue'), 'flex'), '1');
  assert.equal(declaration(owner('.request-episode-queue'), 'display'), 'flex');
  assert.equal(
    declaration(owner('.request-episode-queue'), 'flex-direction'),
    'column'
  );
  assert.equal(
    declaration(owner('.request-episode-queue'), 'height'),
    undefined
  );
});

test('approval text uses shared palette colors without control geometry', () => {
  for (const [state, tone] of [
    ['automatic', 'green'],
    ['required', 'yellow'],
    ['pending', 'orange'],
  ]) {
    assert.equal(
      declaration(
        owner(`.request-approval-text[data-approval-state='${state}']`),
        'color'
      ),
      `var(--palette-${tone}-light)`
    );
  }
  for (const property of [
    'background-color',
    'border',
    'border-radius',
    'padding',
    'height',
  ]) {
    assert.equal(
      declaration(owner('.request-approval-text'), property),
      undefined
    );
  }
  assert.equal(
    declaration(owner('.request-episode-queue-description'), 'margin'),
    'var(--card-spacing) 0 0'
  );
});

test('responsive stacking is reserved for narrow widths, not a normal preview viewport', () => {
  const responsive = rules.filter(
    (rule) =>
      rule.selector === '.request-selection-layout' &&
      rule.parent.name === 'media'
  );
  assert.equal(responsive.length, 1);
  const condition = responsive[0].parent.params.match(
    /^\(max-width:\s*([\d.]+)(rem|px)\)$/
  );
  assert.ok(condition);
  const threshold = Number(condition[1]) * (condition[2] === 'rem' ? 16 : 1);
  assert.ok(600 <= threshold && 720 > threshold);
  assert.equal(
    declaration(responsive[0], 'grid-template-columns'),
    'minmax(0, 1fr)'
  );
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import ts from 'typescript';

const card = readFileSync(
  new URL('../components/RequestCard/index.tsx', import.meta.url),
  'utf8'
);
const slider = readFileSync(
  new URL(
    '../components/Discover/RecentRequestsSlider/index.tsx',
    import.meta.url
  ),
  'utf8'
);
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const layout = 'request-card-compact-layout';
const parse = (source) =>
  ts.createSourceFile(
    'request.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
const collect = (root, predicate) => {
  const found = [];
  const visit = (node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};
const attribute = (node, name) =>
  node.attributes.properties.find(
    (item) => ts.isJsxAttribute(item) && item.name.getText() === name
  );
const expression = (node) =>
  ts.isJsxExpression(node) ? node.expression : node;
const classes = (value, compact) => {
  value = expression(value);
  if (ts.isParenthesizedExpression(value))
    return classes(value.expression, compact);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    return value.text;
  if (ts.isTemplateExpression(value))
    return (
      value.head.text +
      value.templateSpans
        .map((span) => classes(span.expression, compact) + span.literal.text)
        .join('')
    );
  if (
    ts.isConditionalExpression(value) &&
    ts.isIdentifier(value.condition) &&
    value.condition.text === 'compact'
  )
    return classes(compact ? value.whenTrue : value.whenFalse, compact);
  throw new Error(
    'Unresolved root class composition; inspect the actual compact branch'
  );
};
const tokens = (node, compact) =>
  new Set(
    classes(attribute(node, 'className').initializer, compact)
      .split(/\s+/)
      .filter(Boolean)
  );
const openings = (root) =>
  collect(
    root,
    (node) => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
  );
const functionBody = (source, name) => {
  const declaration = collect(
    parse(source),
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
  )[0];
  assert(
    declaration && ts.isArrowFunction(declaration.initializer),
    `${name} retains its component implementation`
  );
  return declaration.initializer.body;
};
const placeholderRoot = (source, compact) => {
  const body = functionBody(source, 'RequestCardPlaceholder');
  for (const statement of body.statements) {
    let branch = statement;
    if (
      ts.isIfStatement(statement) &&
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === 'compact'
    ) {
      branch = compact ? statement.thenStatement : statement.elseStatement;
      if (!branch) continue;
    }
    const returned = ts.isReturnStatement(branch)
      ? [branch]
      : ts.isBlock(branch)
        ? collect(branch, ts.isReturnStatement)
        : [];
    if (returned.length) {
      const node = openings(returned[0].expression).find((opening) =>
        attribute(opening, 'className')
      );
      assert(node, 'placeholder returns a styled root');
      return node;
    }
  }
  assert.fail('No resolved placeholder return branch');
};
const loadedRoot = (source) =>
  openings(functionBody(source, 'RequestCard')).find(
    (node) =>
      attribute(node, 'data-testid')?.initializer?.text === 'request-card'
  );
const verifyCompactRoot = (node) => {
  assert(node, 'compact card retains its root');
  const active = tokens(node, true);
  assert(
    active.has(layout),
    'compact root must consume the shared geometry owner'
  );
  assert(
    ![...active].some((token) =>
      /^(?:[a-z]+:)*!?(?:w-72|w-96|h-\[9\.5rem\]|min-h-0)$/.test(token)
    ),
    'compact root must not restore competing legacy geometry'
  );
  const style = attribute(node, 'style');
  if (style?.initializer) {
    const geometry = collect(
      style.initializer,
      (item) =>
        ts.isPropertyAssignment(item) &&
        /^(?:width|height|minWidth|minHeight|maxWidth|maxHeight)$/.test(
          item.name.getText().replace(/['"]/g, '')
        )
    );
    assert.equal(
      geometry.length,
      0,
      'compact root must not duplicate geometry inline'
    );
  }
};
const verifyConsumers = (cardSource, sliderSource) => {
  verifyCompactRoot(loadedRoot(cardSource));
  const placeholder = placeholderRoot(cardSource, true);
  verifyCompactRoot(placeholder);
  assert(
    tokens(placeholder, true).has('request-card-placeholder'),
    'compact placeholder retains its surface/effect role'
  );
  const fallback = openings(functionBody(cardSource, 'RequestCard')).filter(
    (node) => node.tagName.getText() === 'RequestCardPlaceholder'
  );
  assert(fallback.length > 0, 'per-item metadata fallback remains');
  for (const node of fallback)
    assert.equal(
      expression(attribute(node, 'compact')?.initializer)?.getText(),
      'compact',
      'per-item placeholder must forward compact'
    );
  const row = openings(parse(sliderSource)).filter((node) =>
    ['RequestCard.Placeholder', 'RequestCard'].includes(node.tagName.getText())
  );
  assert(
    row.some((node) => node.tagName.getText() === 'RequestCard.Placeholder'),
    'row placeholder remains'
  );
  assert(
    row.some((node) => node.tagName.getText() === 'RequestCard'),
    'loaded row cards remain'
  );
  for (const node of row) {
    const option = attribute(node, 'compact');
    assert(
      option &&
        (!option.initializer ||
          expression(option.initializer)?.kind === ts.SyntaxKind.TrueKeyword),
      'row loaded/placeholder consumers must select compact'
    );
  }
};
const verifyGeometry = (stylesheet) => {
  const root = postcss.parse(stylesheet);
  const declarations = (selector, property) => {
    const found = [];
    root.walkRules((rule) => {
      if (rule.selectors.includes(selector))
        rule.walkDecls(property, (decl) => found.push(decl.value));
    });
    return found;
  };
  assert.deepEqual(
    declarations(`.${layout}`, 'width'),
    ['var(--request-card-compact-width)'],
    'compact width has one shared owner'
  );
  assert.deepEqual(
    declarations(`.${layout}`, 'min-height'),
    ['var(--request-card-compact-height)'],
    'loaded baseline uses the shared height variable'
  );
  for (const property of ['height', 'max-height', 'overflow'])
    assert.equal(
      declarations(`.${layout}`, property).length,
      0,
      'loaded compact content may grow without new clipping/fixed height'
    );
  assert.deepEqual(
    declarations('.request-card-placeholder', 'height'),
    ['var(--request-card-compact-height)'],
    'placeholder matches the loaded baseline, not retired 9.5rem'
  );
  for (const property of [
    'width',
    'min-width',
    'max-width',
    'min-height',
    'max-height',
  ])
    assert.equal(
      declarations('.request-card-placeholder', property).length,
      0,
      'placeholder must not duplicate shared geometry'
    );
  const variables = new Map();
  root.walkDecls(/^--request-card-compact-(?:width|height)$/, (decl) => {
    let media;
    for (let parent = decl.parent; parent; parent = parent.parent)
      if (parent.type === 'atrule' && parent.name === 'media')
        media = parent.params;
    const key = `${decl.prop}:${media ? 'wide' : 'base'}`;
    assert(
      !variables.has(key),
      'compact responsive variables have one effective owner'
    );
    if (media)
      assert.match(
        media,
        /min-width\s*:\s*640px/,
        'compact breakpoint retains established 640px boundary'
      );
    variables.set(key, decl.value);
  });
  assert.deepEqual(
    Object.fromEntries(variables),
    {
      '--request-card-compact-width:base': '18rem',
      '--request-card-compact-height:base': '7.5rem',
      '--request-card-compact-width:wide': '24rem',
      '--request-card-compact-height:wide': '7.75rem',
    },
    'loaded and placeholder share desktop/narrow dimensions'
  );
};

test('loaded, row-loading and per-item loading select the same compact owner', () =>
  verifyConsumers(card, slider));
test('compact loaded baseline and placeholder share responsive CSS geometry', () =>
  verifyGeometry(css));
test('ordinary noncompact cards retain their separate geometry', () => {
  for (const node of [loadedRoot(card), placeholderRoot(card, false)]) {
    const active = tokens(node, false);
    assert(!active.has(layout));
    for (const token of ['w-72', 'sm:w-96', 'min-h-[17rem]'])
      assert(active.has(token), `noncompact retains ${token}`);
  }
});
test('consumer checks reject a lost compact selector or restored utility owner', () => {
  assert.throws(
    () =>
      verifyConsumers(
        card,
        slider.replace(
          '<RequestCard.Placeholder compact',
          '<RequestCard.Placeholder'
        )
      ),
    /must select compact/
  );
  assert.throws(
    () =>
      verifyConsumers(
        card.replace('compact={compact}', 'compact={false}'),
        slider
      ),
    /must forward compact/
  );
  assert.throws(
    () => verifyConsumers(card.replaceAll(layout, `${layout} w-72`), slider),
    /competing legacy geometry/
  );
  assert.throws(
    () =>
      verifyConsumers(
        card.replaceAll(layout, 'request-card-retired-layout'),
        slider
      ),
    /shared geometry owner/
  );
});
test('geometry checks reject the old tall placeholder and competing loaded height', () => {
  assert.throws(
    () =>
      verifyGeometry(`${css}\n.request-card-placeholder { height: 9.5rem; }`),
    /placeholder matches/
  );
  assert.throws(
    () => verifyGeometry(`${css}\n.${layout} { height: 7.5rem; }`),
    /may grow/
  );
  assert.throws(
    () => verifyGeometry(`${css}\n.request-card-placeholder { width: 18rem; }`),
    /duplicate shared geometry/
  );
});

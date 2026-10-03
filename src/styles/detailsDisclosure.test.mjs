import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const ts = createRequire(import.meta.url)('typescript');

const verifySeriesDisclosure = (source) => {
  const ast = ts.createSourceFile(
    'Series.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const effects = [];
  const buttons = [];
  const panels = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'useEffect'
    )
      effects.push(node);
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(ast) === 'DetailDisclosureButton'
    )
      buttons.push(node);
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(ast) === 'section'
    )
      panels.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const attribute = (element, name) =>
    element.attributes.properties.find(
      (property) => ts.isJsxAttribute(property) && property.name.text === name
    )?.initializer;
  const expression = (element, name) => {
    const value = attribute(element, name);
    return value && ts.isJsxExpression(value) ? value.expression : undefined;
  };
  const details = buttons.find(
    (button) => attribute(button, 'key')?.text === 'details'
  );
  assert.ok(details, 'Series Details needs its stable disclosure role');
  assert.equal(
    expression(details, 'label')?.getText(ast),
    'intl.formatMessage(messages.seriesDetails)',
    'Series Details must retain its localized label'
  );
  assert.equal(
    expression(details, 'open')?.getText(ast),
    'showDetails',
    'Series Details must remain controlled by visibility state'
  );
  assert.equal(
    expression(details, 'pinned')?.getText(ast),
    'pins.details',
    'Series Details must retain its independent pin state'
  );
  const effect = effects.find((candidate) =>
    candidate.arguments[0]?.getText(ast).includes('setShowDetails(')
  );
  assert.ok(
    effect,
    'Series Details must synchronize visibility with pin and review overrides'
  );
  assert.ok(
    ts.isArrayLiteralExpression(effect.arguments[1]),
    'Series Details visibility needs explicit effect dependencies'
  );
  assert.deepEqual(
    effect.arguments[1].elements.map((node) => node.getText(ast)),
    ['pins.details', 'data.id', 'expandInformation', 'collapseInformation'],
    'Series Details must reset on title, pin and review context changes'
  );
  // Execute the actual isolated effect callback: no imports, hooks or providers.
  const synchronize = new Function(
    'setShowDetails',
    'pins',
    'data',
    'expandInformation',
    'collapseInformation',
    `return (${effect.arguments[0].getText(ast)})();`
  );
  for (const pinned of [false, true]) {
    for (const expanded of [false, true]) {
      for (const collapsed of [false, true]) {
        const updates = [];
        synchronize(
          (value) => updates.push(value),
          { details: pinned },
          { id: 1 },
          expanded,
          collapsed
        );
        assert.deepEqual(
          updates,
          [!collapsed && (expanded || pinned)],
          'Series Details visibility must honor collapse precedence and pin/expand state'
        );
      }
    }
  }
  const toggle = expression(details, 'onClick');
  assert.ok(toggle, 'Series Details needs an independent toggle callback');
  const toggleUpdates = [];
  new Function('setShowDetails', `return (${toggle.getText(ast)})();`)(
    (update) => toggleUpdates.push([update(false), update(true)])
  );
  assert.deepEqual(
    toggleUpdates,
    [[true, false]],
    'Series Details click must toggle only visibility'
  );
  const pin = expression(details, 'onPinClick');
  assert.ok(pin, 'Series Details needs a pin callback');
  const pinUpdates = [];
  new Function(
    'togglePinned',
    'setShowDetails',
    `return (${pin.getText(ast)})();`
  )(
    (role) => pinUpdates.push(role),
    () =>
      assert.fail('Series pin must not directly change disclosure visibility')
  );
  assert.deepEqual(
    pinUpdates,
    ['details'],
    'Series Details pin must target only its own role'
  );
  const target = attribute(details, 'controls')?.text;
  assert.equal(
    target,
    'tv-additional-details',
    'Series Details must retain its accessible panel target'
  );
  const panel = panels.find(
    (node) => attribute(node.openingElement, 'id')?.text === target
  );
  assert.ok(panel, 'Series Details must render the controlled panel target');
  const conditional = panel.parent;
  assert.ok(
    ts.isParenthesizedExpression(conditional) &&
      ts.isBinaryExpression(conditional.parent) &&
      conditional.parent.operatorToken.kind ===
        ts.SyntaxKind.AmpersandAmpersandToken &&
      conditional.parent.left.getText(ast) === 'showDetails',
    'Series Details panel must render only when its visibility state is open'
  );
};
for (const [file, media, label] of [
  ['MovieDetails/MovieDetailsLayout', 'movie', 'movieDetails'],
  ['TvDetails/SeriesDetailsLayout', 'tv', 'seriesDetails'],
  ['BookDetails/BookDetailsLayout', 'book', 'bookDetails'],
  ['MusicDetails/MusicDetailsLayout', 'music', 'albumDetails'],
]) {
  test(
    media +
      ' details use the shared disclosure button, pin and controlled card',
    () => {
      const source = read('../components/' + file + '.tsx');
      if (media === 'tv') {
        verifySeriesDisclosure(source);
        return;
      }
      assert.match(source, /setShowDetails\(pins\.details\)/);
      assert.match(source, /\[pins\.details, data\.id\]/);
      assert.ok(
        source.includes('label={intl.formatMessage(messages.' + label + ')}')
      );
      assert.match(source, /pinned=\{pins\.details\}/);
      assert.match(source, /togglePinned\('details'\)/);
      assert.ok(source.includes('controls="' + media + '-additional-details"'));
      assert.ok(source.includes('id="' + media + '-additional-details"'));
      assert.match(source, /\{showDetails && \(/);
      assert.match(source, /className="media-detail-disclosure-row"/);
    }
  );
}

test('Series controlled disclosure checks reject lost collapse precedence and pin/toggle coupling', () => {
  const source = read('../components/TvDetails/SeriesDetailsLayout.tsx');
  const collapse = source.replace(
    'setShowDetails(!collapseInformation && (expandInformation || pins.details));',
    'setShowDetails(expandInformation || pins.details);'
  );
  assert.notEqual(collapse, source, 'collapse-precedence mutation must apply');
  assert.throws(
    () => verifySeriesDisclosure(collapse),
    /Series Details visibility must honor collapse precedence and pin\/expand state/
  );
  const coupled = source.replace(
    "onPinClick={() => void togglePinned('details')}",
    "onPinClick={() => { setShowDetails(true); void togglePinned('details'); }}"
  );
  assert.notEqual(coupled, source, 'pin-coupling mutation must apply');
  assert.throws(
    () => verifySeriesDisclosure(coupled),
    /Series pin must not directly change disclosure visibility/
  );
});

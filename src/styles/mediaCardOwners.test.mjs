import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { styleContract } from './cssContract.mjs';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

const verifyOwners = (stylesheet) => {
  const contract = styleContract(stylesheet);
  assert.equal(
    contract.declaration('.refreshed-card-surface', 'padding'),
    'var(--main-card-padding) !important',
    'main surfaces retain the main padding owner'
  );
  assert.equal(
    contract.declaration('.refreshed-inset-surface', 'padding'),
    'var(--inset-card-padding) !important',
    'inset surfaces retain their independent padding owner'
  );
  assert.equal(
    contract.declaration('.media-detail-card', 'padding'),
    undefined,
    'media main cards must not also consume the inset padding owner'
  );
  assert.ok(
    ![...contract.applies('.media-detail-card')].some((token) =>
      /^(?:[a-z]+:)*!?p(?:[trblxyse])?-/.test(token)
    ),
    'media cards must not duplicate padding through a retired utility'
  );
  for (const property of ['backdrop-filter', '-webkit-backdrop-filter']) {
    assert.equal(
      contract.declaration('.refreshed-card-surface', property),
      'blur(4px)',
      'shared surfaces retain the established blur owner'
    );
    assert.equal(
      contract.declaration('.media-detail-card', property),
      undefined,
      'media cards must not duplicate the shared blur owner'
    );
  }
};

test('media main cards use one shared padding and blur owner', () => {
  verifyOwners(css);
});

test('Requests and Series attach the shared main surface to media cards', () => {
  for (const path of [
    '../components/Requests/index.tsx',
    '../components/TvDetails/SeriesDetailsLayout.tsx',
  ]) {
    const source = ts.createSourceFile(
      path,
      readFileSync(new URL(path, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const consumers = [];
    const visit = (node) => {
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(source) === 'className' &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        const classes = new Set(node.initializer.text.split(/\s+/));
        if (classes.has('media-detail-card')) consumers.push(classes);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(consumers.length > 0, `${path} retains its media-card consumer`);
    for (const classes of consumers) {
      assert.ok(classes.has('app-card-main'), `${path} selects the main role`);
      assert.ok(
        classes.has('refreshed-card-surface'),
        `${path} consumes shared padding and surface effects`
      );
    }
  }
});

test('media-card checks reject reintroduced padding and effect duplicates', () => {
  for (const [rule, diagnostic] of [
    [
      '.refreshed-inset-surface, .media-detail-card { padding: var(--inset-card-padding) !important; }',
      /must not also consume the inset padding owner/,
    ],
    ['.media-detail-card { @apply p-4; }', /retired utility/],
    ['.media-detail-card { backdrop-filter: blur(4px); }', /blur owner/],
    [
      '.media-detail-card { -webkit-backdrop-filter: blur(4px); }',
      /blur owner/,
    ],
  ]) {
    assert.throws(() => verifyOwners(`${css}\n${rule}`), diagnostic);
  }
});

const verifyPosterPosition = (stylesheet) => {
  const contract = styleContract(stylesheet);
  assert.equal(
    contract.declaration('.poster-layout', 'position'),
    'relative',
    'poster layout retains positioning ownership'
  );
  assert.equal(
    contract.declaration('.title-card-shell', 'position'),
    undefined,
    'poster shell must not duplicate layout positioning'
  );
  assert.equal(
    contract.declaration('.title-card-shell', 'z-index'),
    '0',
    'poster shell retains its independent stacking role'
  );
};

test('shared poster layout owns position while the shell retains stacking', () => {
  verifyPosterPosition(css);
  for (const path of [
    '../components/TitleCard/index.tsx',
    '../components/TitleCard/Placeholder.tsx',
    '../components/TitleCard/ErrorCard.tsx',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const consumers = [
      ...source.matchAll(/className="([^"]*\btitle-card-shell\b[^"]*)"/g),
    ];
    assert.ok(consumers.length > 0, `${path} retains its poster shell`);
    for (const [, classes] of consumers) {
      assert.ok(
        classes.split(/\s+/).includes('poster-layout'),
        `${path} attaches the positioning owner`
      );
    }
  }
});

test('poster-position checks reject a restored duplicate or lost owner', () => {
  assert.throws(
    () =>
      verifyPosterPosition(`${css}\n.title-card-shell { position: relative; }`),
    /must not duplicate layout positioning/
  );
  assert.throws(
    () => verifyPosterPosition(`${css}\n.poster-layout { position: static; }`),
    /retains positioning ownership/
  );
});

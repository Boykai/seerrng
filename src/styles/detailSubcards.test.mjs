import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import ts from 'typescript';
import { styleContract } from './cssContract.mjs';
import { auditTailwindClassExpressions } from './tailwindClassVerifier.mjs';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

const verifyNativeRequestInset = (source, stylesheet) => {
  const tree = ts.createSourceFile(
    'TvRequestModal.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const summaries = [];
  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const classes = node.openingElement.attributes.properties.find(
        (entry) => ts.isJsxAttribute(entry) && entry.name.text === 'className'
      )?.initializer;
      if (
        classes &&
        ts.isStringLiteral(classes) &&
        classes.text.split(/\s+/).includes('detail-summary-card')
      )
        summaries.push([node, classes.text.split(/\s+/)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(summaries.length, 1, 'request owns one summary inset');
  const [summary, classes] = summaries[0];
  for (const role of ['app-card-inset', 'refreshed-inset-surface'])
    assert.ok(classes.includes(role), `request summary retains ${role}`);
  let requestCard;
  for (let parent = summary.parent; parent; parent = parent.parent)
    if (
      ts.isJsxElement(parent) &&
      parent.openingElement.tagName.getText() === 'RequestMediaCard'
    )
      requestCard = parent;
  assert.ok(
    requestCard,
    'request summary remains inside the shared artwork card'
  );
  assert.deepEqual(
    auditTailwindClassExpressions({
      path: 'TvRequestModal.tsx',
      source: summary.getText(),
    }).utilities,
    [],
    'request summary has no competing utility geometry'
  );
  const contract = styleContract(stylesheet);
  for (const [selector, property, expected] of [
    [
      ':is(.app-card-main, .app-card-sub, .app-card-inset)',
      'border-width',
      '0 !important',
    ],
    [':is(.app-card-sub, .app-card-inset)', '--app-card-frame-width', '1px'],
    [':is(.app-card-sub, .app-card-inset)', 'border-radius', '0.5rem'],
    [
      ':is(.app-card-main, .app-card-sub, .app-card-inset)::after',
      'padding',
      'var(--app-card-frame-width)',
    ],
    [
      ':is(.app-card-main, .app-card-sub, .app-card-inset)::after',
      'mask-composite',
      'exclude',
    ],
    [
      ':is(.app-card-main, .app-card-sub, .app-card-inset)::after',
      'pointer-events',
      'none',
    ],
    [
      '.refreshed-inset-surface',
      'padding',
      'var(--inset-card-padding) !important',
    ],
    [
      '.request-modal-site-surface .refreshed-inset-surface',
      'background-color',
      'rgb(var(--color-gray-900) / 0.3)',
    ],
  ])
    assert.equal(
      contract.declaration(selector, property),
      expected,
      `request inset ${property} remains with its shared owner`
    );
  for (const role of ['.refreshed-inset-surface', '.detail-summary-card'])
    for (const property of ['border', 'border-width', 'border-radius'])
      assert.equal(
        contract.declaration(role, property),
        undefined,
        'surface and summary roles do not duplicate frame geometry'
      );
};
for (const file of [
  'CollectionDetails/index.tsx',
  'CollectionDetails/CollectionSummaryCard.tsx',
  'TvDetails/SeriesDetailsLayout.tsx',
  'BookDetails/BookDetailsLayout.tsx',
  'MusicDetails/MusicDetailsLayout.tsx',
  'Requests/index.tsx',
  ...['Movie', 'Book', 'Music', 'Collection'].map(
    (type) => `RequestModal/${type}RequestModal.tsx`
  ),
]) {
  test(`${file} puts its poster and summary in the shared inset`, () => {
    if (file === 'RequestModal/CollectionRequestModal.tsx') {
      assert.match(read(`../components/${file}`), /<CollectionSummaryCard/);
      assert.match(
        read('../components/CollectionDetails/CollectionSummaryCard.tsx'),
        /detail-item-surface detail-summary-card media-detail-collection-card/
      );
      return;
    }
    assert.match(
      read(`../components/${file}`),
      /(?:refreshed-inset-surface|detail-item-surface) detail-summary-card/
    );
  });
}

test('movie pages and collection members reuse the shared movie summary surface', () => {
  for (const file of [
    'MovieDetails/MovieDetailsLayout.tsx',
    'CollectionDetails/index.tsx',
  ]) {
    assert.match(read(`../components/${file}`), /<MovieSummaryCard/);
  }
  const source = read('../components/MediaDetails/MovieSummaryCard.tsx');
  assert.match(source, /detail-summary-card movie-summary-card/);
  assert.match(source, /detail-item-surface movie-summary-with-ratings/);
  assert.match(source, /refreshed-inset-surface/);
});

test('single-summary list entries do not add an extra inset card', () => {
  for (const file of [
    'Blocklist/index.tsx',
    'Association/AssociationDetailCard.tsx',
    'IssueList/IssueItem/index.tsx',
  ]) {
    const source = read(`../components/${file}`);
    assert.match(source, /refreshed-card-surface/);
    assert.doesNotMatch(source, /refreshed-inset-surface detail-summary-card/);
  }
});

const verifyIssueInsets = (source) => {
  const outer = source
    .match(/embedded\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/)
    ?.slice(1);
  assert.ok(outer, 'issue outer card retains embedded and standalone branches');
  assert.match(
    outer[0],
    /\bapp-card-inset\b/,
    'embedded issue uses one outer inset'
  );
  assert.match(outer[0], /\brefreshed-inset-surface\b/);
  assert.match(
    outer[1],
    /\bapp-card-main\b/,
    'standalone issue uses the main card'
  );
  const inner = source.match(/embedded\s*\?\s*''\s*:\s*'([^']+)'/)?.[1];
  assert.ok(inner, 'embedded issue does not duplicate an inner inset');
  for (const role of [
    'app-card-inset',
    'refreshed-inset-surface',
    'detail-summary-card',
  ])
    assert.ok(
      inner.split(/\s+/).includes(role),
      `standalone issue summary retains ${role}`
    );
};

test('issue detail pages retain one inset in embedded and standalone contexts', () => {
  verifyIssueInsets(read('../components/IssueDetails/IssueMediaSummary.tsx'));
});

test('issue inset verification rejects lost embedded and standalone owners', () => {
  const source = read('../components/IssueDetails/IssueMediaSummary.tsx');
  for (const [before, after, diagnostic] of [
    [
      "embedded ? 'app-card-inset refreshed-inset-surface'",
      "embedded ? 'refreshed-inset-surface'",
      /embedded issue uses one outer inset/,
    ],
    [
      "embedded ? '' : 'app-card-inset refreshed-inset-surface detail-summary-card'",
      "embedded ? '' : 'app-card-inset refreshed-inset-surface'",
      /standalone issue summary retains detail-summary-card/,
    ],
  ]) {
    const broken = source.replace(before, after);
    assert.notEqual(broken, source);
    assert.throws(() => verifyIssueInsets(broken), diagnostic);
  }
});

test('blocklist source badges explain the method and retain matching tags', () => {
  const source = read('../components/Blocklist/index.tsx');
  assert.match(source, /Someone explicitly blocked this title in Seerr\./);
  assert.match(
    source,
    /content=\{intl.formatMessage\(messages.manualSourceTooltip\)\}/
  );
  const tags = read('../components/BlocklistedTagsBadge/index.tsx');
  assert.match(
    tags,
    /Automatically blocked because this title matched a configured blocked content tag/
  );
  assert.match(tags, /tags: tagNamesBlocklistedFor/);
});

test('blocklist removal is inside the final details column, after Source', () => {
  const source = read('../components/Blocklist/index.tsx');
  const finalColumn = source.slice(
    source.indexOf(
      '<dl className="media-detail-rows refreshed-detail-text media-detail-column-divider'
    )
  );
  const endColumn = finalColumn.indexOf('</dl>');
  assert.ok(
    finalColumn.indexOf('messages.source') <
      finalColumn.indexOf('onClick={() => void removeFromBlocklist()}')
  );
  assert.ok(
    finalColumn.indexOf('onClick={() => void removeFromBlocklist()}') <
      endColumn
  );
  assert.equal(
    (source.match(/onClick=\{\(\) => void removeFromBlocklist\(\)\}/g) ?? [])
      .length,
    1
  );
});

test('summary subcards reuse native standalone framing and shared inset padding', () => {
  const contract = styleContract(read('./globals.css'));
  const selector =
    ':where(.detail-summary-card:not(.app-card-inset):not(.app-card-sub))';
  for (const [property, expected] of Object.entries({
    'border-radius': '0.5rem',
    'border-width': '1px',
    'border-style': 'solid',
    'border-color': 'rgb(var(--color-gray-700))',
  })) {
    assert.equal(contract.declaration(selector, property), expected);
    assert.equal(
      contract.declaration('.detail-summary-card', property),
      undefined,
      'framed summaries leave geometry to the shared card role'
    );
  }
  assert.equal(contract.applies('.detail-summary-card').size, 0);
  assert.equal(contract.applies(selector).size, 0);
  assert.equal(
    contract.declaration('.detail-summary-card', 'padding'),
    'var(--inset-card-padding)'
  );
  assert.equal(
    contract.declaration('.refreshed-inset-surface', 'padding'),
    'var(--inset-card-padding) !important'
  );
  // The accepted request shell now consumes the shared inset frame; the
  // standalone fallback above remains available only to unframed summaries.
  verifyNativeRequestInset(
    read('../components/RequestModal/TvRequestModal.tsx'),
    read('./globals.css')
  );
});

test('native request inset verification rejects lost roles, copied utilities and broken frame ownership', () => {
  const source = read('../components/RequestModal/TvRequestModal.tsx');
  const css = read('./globals.css');
  for (const [before, after, diagnostic] of [
    [
      'app-card-inset refreshed-inset-surface detail-summary-card',
      'refreshed-inset-surface detail-summary-card',
      /retains app-card-inset/,
    ],
    [
      'app-card-inset refreshed-inset-surface detail-summary-card',
      'app-card-inset detail-summary-card',
      /retains refreshed-inset-surface/,
    ],
    [
      'app-card-inset refreshed-inset-surface detail-summary-card',
      'app-card-inset refreshed-inset-surface detail-summary-card rounded-lg border',
      /competing utility geometry/,
    ],
  ]) {
    const broken = source.replace(before, after);
    assert.notEqual(broken, source);
    assert.throws(() => verifyNativeRequestInset(broken, css), diagnostic);
  }
  const brokenRoot = postcss.parse(css);
  brokenRoot.walkRules((rule) => {
    if (
      rule.selectors.includes(
        ':is(.app-card-main, .app-card-sub, .app-card-inset)::after'
      )
    )
      rule.walkDecls('mask-composite', (decl) => {
        decl.value = 'add';
      });
  });
  const brokenCss = brokenRoot.toString();
  assert.notEqual(brokenCss, css);
  assert.throws(
    () => verifyNativeRequestInset(source, brokenCss),
    /mask-composite remains with its shared owner/
  );
});

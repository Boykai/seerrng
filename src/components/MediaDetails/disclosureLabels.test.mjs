import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const ts = createRequire(import.meta.url)('typescript');
const seriesFile = '../TvDetails/SeriesDetailsLayout.tsx';
const seriesRoles = [
  'overview',
  'cast',
  'crew',
  'subjectTags',
  'details',
  'mediaServer',
];

// The accepted Series contract is saved role ordering, not Details always last.
// Check real JSX ownership instead of splitting a retired literal div wrapper.
const verifySeriesOrder = (source) => {
  const ast = ts.createSourceFile(
    'Series.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const rows = [];
  const panels = [];
  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const name = node.openingElement.tagName.getText(ast);
      if (name === 'ReorderableDisclosureRow') rows.push(node);
      if (name === 'OrderedDisclosurePanels') panels.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(rows.length, 1, 'Series controls need one shared reorder row');
  assert.equal(
    panels.length,
    1,
    'Series panels need one committed-order owner'
  );
  const attribute = (element, name) =>
    element.attributes.properties.find(
      (property) => ts.isJsxAttribute(property) && property.name.text === name
    )?.initializer;
  const expression = (element, name) => {
    const value = attribute(element, name);
    return value && ts.isJsxExpression(value) ? value.expression : undefined;
  };
  assert.equal(
    expression(rows[0].openingElement, 'order')?.getText(ast),
    'disclosureOrder',
    'Series controls must use saved disclosure order'
  );
  assert.equal(
    expression(panels[0].openingElement, 'order')?.getText(ast),
    'disclosureOrder',
    'Series controls and panels must share committed order'
  );
  assert.equal(
    expression(rows[0].openingElement, 'onOrderChange')?.getText(ast),
    'setDisclosureOrder',
    'Series order must retain its persistence callback'
  );
  assert.equal(
    expression(rows[0].openingElement, 'disabled')?.getText(ast),
    '!canReorder',
    'Series reorder must retain its permission guard'
  );
  const leading = expression(rows[0].openingElement, 'leading');
  assert.ok(
    leading &&
      ts.isJsxSelfClosingElement(leading) &&
      leading.tagName.getText(ast) === 'CollectionNavigation',
    'Collection navigation must remain outside reorderable roles'
  );
  assert.equal(
    attribute(leading, 'kind')?.text,
    'tv',
    'Series collection navigation must retain TV context'
  );
  const buttons = [];
  const collectButtons = (node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(ast) === 'DetailDisclosureButton'
    )
      buttons.push(node);
    ts.forEachChild(node, collectButtons);
  };
  rows[0].children.forEach(collectButtons);
  assert.deepEqual(
    buttons.map((button) => attribute(button, 'key')?.text),
    seriesRoles,
    'Series controls must retain all unique stable role keys'
  );
  assert.deepEqual(
    buttons.map((button) => expression(button, 'label')?.getText(ast)),
    [
      'intl.formatMessage(messages.overview)',
      'intl.formatMessage(messages.viewCast)',
      'intl.formatMessage(messages.viewCrew)',
      'intl.formatMessage(messages.subjectTags)',
      'intl.formatMessage(messages.seriesDetails)',
      'intl.formatMessage(messages.mediaServer)',
    ],
    'Series labels must remain attached to their actual roles'
  );
  const fragments = panels[0].children.filter(
    (node) =>
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(ast) === 'Fragment'
  );
  assert.deepEqual(
    fragments.map((node) => attribute(node.openingElement, 'key')?.text),
    seriesRoles,
    'Series panels must retain the same stable role keys'
  );
};

const locale = JSON.parse(
  readFileSync(new URL('../../i18n/locale/en.json', import.meta.url), 'utf8')
);
const layouts = [
  [
    '../MovieDetails/MovieDetailsLayout.tsx',
    'components.MovieDetails.Layout',
    {
      viewCollection: 'Collection',
      viewCast: 'Cast',
      viewCrew: 'Crew',
      movieDetails: 'Details',
    },
  ],
  [
    '../TvDetails/SeriesDetailsLayout.tsx',
    'components.TvDetails.Layout',
    {
      overview: 'Overview',
      viewCast: 'Cast',
      viewCrew: 'Crew',
      seriesDetails: 'Details',
    },
  ],
  [
    '../MusicDetails/MusicDetailsLayout.tsx',
    'components.MusicDetails.Layout',
    { viewArtists: 'Artists', albumDetails: 'Details' },
  ],
  [
    '../BookDetails/BookDetailsLayout.tsx',
    'components.BookDetails.Layout',
    { bookDetails: 'Details' },
  ],
  [
    '../CollectionDetails/CollectionNavigation.tsx',
    'components.CollectionNavigation',
    { view: 'Collection' },
  ],
  [
    '../CollectionDetails/CollectionMetadataDisclosures.tsx',
    'components.CollectionDetails.Metadata',
    { viewCast: 'Cast', viewCrew: 'Crew' },
  ],
];

for (const [file, prefix, labels] of layouts) {
  test(`${prefix} uses matching short defaults and English labels`, () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const [key, label] of Object.entries(labels)) {
      assert.ok(source.includes(`${key}: '${label}'`));
      assert.equal(locale[`${prefix}.${key}`], label);
    }
    assert.doesNotMatch(source, /'View (?:Collection|Artists|Cast|Crew)'/);
    assert.match(source, /<DetailDisclosureButton/);
    assert.match(source, /onPinClick=/);
  });
}

const disclosureOrders = [
  [
    '../MovieDetails/MovieDetailsLayout.tsx',
    ['viewCollection', 'viewCast', 'viewCrew', 'subjectTags', 'movieDetails'],
  ],
  [
    '../TvDetails/SeriesDetailsLayout.tsx',
    ['viewCast', 'viewCrew', 'subjectTags', 'seriesDetails'],
  ],
  [
    '../MusicDetails/MusicDetailsLayout.tsx',
    ['viewArtists', 'subjectTags', 'albumDetails'],
  ],
  // The existing Book row now exposes Collection and Keywords; Details remains
  // last. Preserve that order rather than freezing the retired Genres label.
  [
    '../BookDetails/BookDetailsLayout.tsx',
    ['collection', 'keywords', 'bookDetails'],
  ],
];

for (const [file, order] of disclosureOrders) {
  test(
    file === seriesFile
      ? `${file} shares saved role order between controls and panels`
      : `${file} keeps Details last in the requested disclosure order`,
    () => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      if (file === seriesFile) {
        verifySeriesOrder(source);
        return;
      }
      const row = source
        .split('<div className="media-detail-disclosure-row">')[1]
        .split('</div>')[0];
      const labels = [
        ...row.matchAll(/label={intl.formatMessage\(messages\.(\w+)\)}/g),
      ].map((match) => match[1]);
      assert.deepEqual(labels, order);
      if (file.includes('MusicDetails') || file.includes('TvDetails')) {
        assert.ok(
          row.indexOf('<CollectionNavigation') <
            row.indexOf('<DetailDisclosureButton')
        );
      }
    }
  );
}

test('Series order checks reject split ordering and lost role identity', () => {
  const source = readFileSync(new URL(seriesFile, import.meta.url), 'utf8');
  const split = source.replace(
    '<OrderedDisclosurePanels order={disclosureOrder}>',
    '<OrderedDisclosurePanels order={[]}>'
  );
  assert.notEqual(split, source, 'split-order mutation must apply');
  assert.throws(
    () => verifySeriesOrder(split),
    /Series controls and panels must share committed order/
  );
  const missingRole = source.replace('key="details"', 'key="cast"');
  assert.notEqual(missingRole, source, 'duplicate-role mutation must apply');
  assert.throws(
    () => verifySeriesOrder(missingRole),
    /Series controls must retain all unique stable role keys/
  );
});

test('Request Discography alone opts into the shared right-aligned catalog action style', () => {
  const music = readFileSync(
    new URL('../MusicDetails/index.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    music,
    /buttonType="bulkRequest"\s+buttonSize="sm"\s+className="media-detail-catalog-action"/
  );
  const css = readFileSync(
    new URL('../../styles/globals.css', import.meta.url),
    'utf8'
  );
  assert.match(
    css,
    /\.media-detail-disclosure-row > \.media-detail-catalog-action\s*\{\s*margin-inline-start: auto;/
  );
  assert.doesNotMatch(
    css.match(/\.media-detail-disclosure-row\s*\{([^}]+)\}/)?.[1] ?? '',
    /justify-between/
  );
});

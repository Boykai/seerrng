import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
    { viewCast: 'Cast', viewCrew: 'Crew', seriesDetails: 'Details' },
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
  ['../BookDetails/BookDetailsLayout.tsx', ['genres', 'bookDetails']],
];

for (const [file, order] of disclosureOrders) {
  test(`${file} keeps Details last in the requested disclosure order`, () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
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
  });
}

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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const css = read('./globals.css');

test('summary posters retain their size while the heading gap is reduced by two pixels', () => {
  assert.match(css, /\.detail-card-poster\s*\{\s*width: 4rem;\s*height: 6rem;/);
  assert.match(
    css,
    /\.detail-card-poster\s*\{\s*width: 5rem;\s*height: 7\.5rem;/
  );
  assert.match(css, /--detail-heading-gap: 14px;/);
  assert.match(
    css,
    /\.detail-card-heading-spacing\s*\{\s*margin-top: var\(--detail-heading-gap\)/
  );
  assert.doesNotMatch(css, /\.detail-card-poster\s*\{[^}]*height: auto/);
  assert.match(
    read('../components/IssueList/IssueItem/index.tsx'),
    /detail-card-poster/
  );
  assert.match(
    read('../components/IssueDetails/IssueMediaSummary.tsx'),
    /detail-card-poster/
  );
});

test('detail rows have a consistent baseline but allow content-driven expansion', () => {
  assert.match(css, /--detail-row-height: 1rem;/);
  assert.match(css, /--detail-row-gap: 2px;/);
  assert.match(
    css,
    /grid-auto-rows: minmax\(var\(--detail-row-height\), auto\)/
  );
  assert.match(css, /row-gap: var\(--detail-row-gap\)/);
  assert.match(css, /line-height: var\(--detail-row-height\)/);
  assert.match(
    css,
    /\.media-detail-rows dt,[^{]+\{\s*margin-block: 0;\s*min-height: var\(--detail-row-height\)/
  );
  assert.doesNotMatch(css, /\.media-detail-rows\s*\{[^}]*max-height:/);
});

const cards = [
  'IssueList/IssueItem/index.tsx',
  'IssueDetails/IssueMediaSummary.tsx',
  'MediaDetails/MovieSummaryCard.tsx',
  'TvDetails/SeriesDetailsLayout.tsx',
  'BookDetails/BookDetailsLayout.tsx',
  'MusicDetails/MusicDetailsLayout.tsx',
  'RequestStatus/index.tsx',
  'Blocklist/index.tsx',
  'Association/AssociationDetailCard.tsx',
  ...['Movie', 'Tv', 'Book', 'Music'].map(
    (type) => `RequestModal/${type}RequestModal.tsx`
  ),
];
test('all media summaries use the same paired table and fourth-row genres', () => {
  for (const file of [
    'MediaDetails/MovieSummaryCard.tsx',
    'TvDetails/SeriesDetailsLayout.tsx',
    'BookDetails/BookDetailsLayout.tsx',
    'MusicDetails/MusicDetailsLayout.tsx',
  ]) {
    const source = read(`../components/${file}`);
    assert.match(source, /media-detail-rows detail-paired-columns/);
    assert.match(source, /card:row-start-4/);
    assert.doesNotMatch(source, /detail-paired-simple-columns/);
  }
});
for (const file of cards) {
  test(`${file} uses shared rows without extra fourth-row margins`, () => {
    const source = read(`../components/${file}`);
    assert.match(source, /media-detail-rows/);
    assert.match(source, /detail-card-heading-spacing/);
    for (const line of source.split('\n')) {
      if (line.includes('card:row-start-4'))
        assert.doesNotMatch(line, /\bmt-0\.5\b/);
      if (line.includes('grid-cols-[max-content_minmax(0,1fr)]')) {
        assert.match(line, /media-detail-rows/);
        assert.doesNotMatch(line, /gap-y-|leading-[45]/);
      }
    }
  });
}

test('collection and advanced summaries share the global title gap', () => {
  for (const file of [
    'CollectionDetails/CollectionSummaryCard.tsx',
    'RequestModal/CollectionRequestModal.tsx',
    'RequestModal/AdvancedRequester/index.tsx',
  ]) {
    assert.match(read(`../components/${file}`), /detail-card-heading-spacing/);
  }
  assert.doesNotMatch(css, /\.collection-summary-table\s*\{[^}]*mt-4/);
  assert.match(
    css,
    /\.detail-card-heading-after\s*\{\s*margin-bottom: var\(--detail-heading-gap\)/
  );
  for (const file of [
    'MovieDetails/MovieDetailsLayout.tsx',
    'TvDetails/SeriesDetailsLayout.tsx',
    'BookDetails/BookDetailsLayout.tsx',
    'MusicDetails/MusicDetailsLayout.tsx',
  ]) {
    const source = read(`../components/${file}`);
    assert.match(source, /detail-card-heading-after/);
    assert.doesNotMatch(source, /media-inset-heading mb-3/);
  }
});

test('album and book supplemental details do not repeat summary fields', () => {
  for (const [file, id, removed, retained] of [
    [
      'MusicDetails/MusicDetailsLayout.tsx',
      'music-additional-details',
      ['status', 'releaseDate', 'albumType', 'runtime', 'trackCount', 'artist'],
      ['musicBrainz', 'artistType', 'origin'],
    ],
    [
      'BookDetails/BookDetailsLayout.tsx',
      'book-additional-details',
      ['firstPublished', 'pages', 'editions', 'author'],
      ['publisher', 'edition', 'openLibrary', 'isbnCandidates'],
    ],
  ]) {
    const source = read(`../components/${file}`);
    const details = source.slice(source.indexOf(`id="${id}"`));
    for (const field of removed)
      assert.ok(
        !details.includes(`messages.${field})`),
        `${file}: duplicate ${field}`
      );
    for (const field of retained)
      assert.ok(
        details.includes(`messages.${field})`),
        `${file}: missing ${field}`
      );
    assert.equal((details.match(/<dl /g) ?? []).length, 3);
  }
});

test('button rows share card gaps without legacy modal margins', () => {
  const shared = css.match(
    /\.app-action-row,[^{]+\{\s*gap: var\(--card-spacing\);/
  )?.[0];
  assert.ok(shared);
  for (const selector of [
    'app-modal-actions',
    'media-detail-disclosure-row',
    'media-primary-action-row',
    'request-status-action-row',
    'settings-card-actions',
    'settings-page-actions',
  ]) {
    assert.ok(shared.includes(selector), selector);
  }
  const modal = read('../components/Common/Modal/index.tsx');
  assert.match(modal, /app-modal-actions/);
  assert.doesNotMatch(modal, /className="ml-3/);
  for (const file of ['ManageSlideOver', 'ExternalMediaManageSlideOver']) {
    assert.doesNotMatch(
      read(`../components/${file}/index.tsx`),
      /!mt-\[5px\]|space-y-\[5px\]/
    );
  }
});

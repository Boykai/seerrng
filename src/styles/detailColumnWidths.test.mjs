import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
test('shared middle groups center as one unit and stretch across their allotted rows', () => {
  const css = read('./globals.css');
  assert.match(
    css,
    /\.detail-paired-columns > \.media-detail-column-divider,\s*\.detail-paired-simple-columns > \.media-detail-column-divider,[\s\S]*?width: max-content;\s*max-width: 100%;\s*justify-self: center;\s*align-self: stretch;/
  );
  assert.match(
    css,
    /\.detail-three-column-grid:not\(:has\(> \.detail-paired-column-span\)\)\s*> \.media-detail-column-divider:nth-child\(2\)/
  );
});
const files = [
  'MediaDetails/MovieSummaryCard.tsx',
  'TvDetails/SeriesDetailsLayout.tsx',
  'BookDetails/BookDetailsLayout.tsx',
  'MusicDetails/MusicDetailsLayout.tsx',
  'Blocklist/index.tsx',
  'IssueDetails/IssueMediaSummary.tsx',
  'IssueList/IssueItem/index.tsx',
  'RequestStatus/index.tsx',
  ...['Book', 'Movie', 'Music', 'Tv'].map(
    (x) => `RequestModal/${x}RequestModal.tsx`
  ),
];
for (const file of files)
  test(`${file} shares proportional columns instead of a fixed first value width`, () => {
    const source = read(`../components/${file}`);
    assert.match(source, /detail-paired-column-span/);
    assert.match(source, /detail-paired-columns/);
    for (const line of source
      .split('\n')
      .filter(
        (line) =>
          line.includes('className=') && line.includes('detail-paired-columns')
      )) {
      assert.doesNotMatch(
        line,
        /grid-cols-\[|gap-x-/,
        'Local utilities must not override the shared column tracks or gaps'
      );
    }
    assert.doesNotMatch(source, /card:grid-cols-\[max-content_0\.75rem_6rem/);
  });
test('paired spans share intrinsic parent tracks without fixed proportions', () => {
  const css = read('./globals.css');
  assert.match(
    css,
    /\.detail-paired-column-span \.media-detail-rows\.detail-paired-columns\s*\{[^}]*grid-column: 1 \/ -1;[^}]*grid-template-columns: subgrid;/
  );
  assert.match(css, /\.detail-paired-column-span\s*\{\s*padding-right: 0;/);
  assert.match(
    css,
    /\.collection-summary-table\s*\{\s*grid-template-columns:\s*max-content minmax\(0, 1fr\)\s+fit-content\(\s*var\(--detail-last-column-limit\)\s*\)/
  );
  assert.match(
    read('../components/MusicDetails/MusicDetailsLayout.tsx'),
    /detail-paired-column-span min-w-0/
  );
});

test('all three-column details layouts use the shared responsive grid', () => {
  for (const file of [
    ...files,
    'MovieDetails/MovieDetailsLayout.tsx',
    'MusicDetails/MusicDetailsLayout.tsx',
    'Association/AssociationDetailCard.tsx',
  ]) {
    const source = read(`../components/${file}`);
    assert.match(source, /detail-three-column-grid/, file);
    assert.doesNotMatch(source, /card:grid-cols-3/, file);
  }
  const css = read('./globals.css');
  assert.doesNotMatch(css, /--detail-(first|middle|final)-column-share/);
  assert.match(
    css,
    /\.detail-three-column-grid\s*\{[^}]*grid-template-columns:\s*fit-content\(var\(--detail-first-column-limit\)\) minmax\(0, 1fr\)\s*fit-content\(var\(--detail-last-column-limit\)\)/
  );
  assert.match(
    css,
    /\.movie-summary-fields-with-ratings\s*\{[^}]*grid-template-columns:\s*max-content 0\.75rem fit-content\(var\(--detail-first-value-limit\)\) 0\.75rem\s*minmax\(0, 1fr\) fit-content\(var\(--detail-last-column-limit\)\)/
  );
  assert.match(
    css,
    /\.detail-paired-simple-columns\s*\{[^}]*grid-template-columns: subgrid;/
  );
  for (const file of files) {
    for (const line of read(`../components/${file}`)
      .split('\n')
      .filter(
        (line) =>
          line.includes('className=') &&
          line.includes('detail-paired-column-span')
      )) {
      assert.doesNotMatch(
        line,
        /card:col-span-2/,
        'Local spans cannot override the six shared parent tracks'
      );
    }
  }
});

test('details titles share their optical alignment without local negative margins', () => {
  for (const file of files
    .filter((file) => !file.includes('MovieSummaryCard'))
    .concat([
      'MusicDetails/MusicDetailsLayout.tsx',
      'Association/AssociationDetailCard.tsx',
      'RequestModal/CollectionRequestModal.tsx',
    ])) {
    const source = read(`../components/${file}`);
    assert.match(source, /detail-summary-title/, file);
    for (const line of source
      .split('\n')
      .filter((line) => line.includes('detail-summary-title')))
      assert.doesNotMatch(line, /-mt-/, file);
  }
});
test('collection defaults to HD and filters both playback buttons without a hidden default fallback', () => {
  const source = read('../components/CollectionDetails/index.tsx');
  assert.match(source, /useState<'hd' \| '4k'>\('hd'\)/);
  assert.match(source, /autoSelectAvailable=\{false\}/);
  assert.match(source, /collectionPartHasQuality\(part, playbackQuality\)/);
  assert.match(source, /collectionMediaIds=\{effectivePlaybackMediaIds\}/);
  assert.match(source, /mediaIds=\{effectivePlaybackMediaIds\}/);
  assert.doesNotMatch(source, /resolveCanonicalPlaybackSelection/);
});
test('collection trailer belongs to the first chronological member, not the selected playback member', () => {
  const source = read('../components/CollectionDetails/index.tsx');
  assert.match(source, /const firstPart = orderedParts\[0\]/);
  assert.match(
    source,
    /memberById\.get\(firstPart.id\)\?\.details\?\.relatedVideos/
  );
  assert.match(source, /buttonType="trailer"/);
});

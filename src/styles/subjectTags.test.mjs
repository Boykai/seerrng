import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const palette = readFileSync(
  new URL('../components/MediaDetails/subjectTagStyle.ts', import.meta.url),
  'utf8'
);
const tones = [
  'rose',
  'orange',
  'amber',
  'yellow',
  'lime',
  'emerald',
  'sky',
  'indigo',
  'violet',
  'purple',
];

test('subject-tag tones use matching colored text and translucent fills', () => {
  for (const tone of tones) {
    assert.ok(palette.includes(`'${tone}'`));
    assert.match(
      css,
      new RegExp(
        `\\.subject-tag-${tone} \\{\\s*@apply border-${tone}-400/80 bg-${tone}-500/20 text-${tone}-400 hover:bg-${tone}-500/35;`
      )
    );
  }
});

test('cyan tags match the Associations button palette without white hover text', () => {
  assert.ok(palette.includes("'cyan'"));
  const tag = css.match(/\.subject-tag-cyan \{([^}]+)\}/)[1];
  const association = css.match(/\.app-button-association \{([^}]+)\}/)[1];
  for (const token of [
    'border-cyan-500/90',
    'bg-cyan-950/35',
    'text-cyan-300',
    'hover:bg-cyan-900/55',
  ]) {
    assert.ok(tag.includes(token));
    assert.ok(association.includes(token));
  }
  assert.ok(!tag.includes('text-white'));
});

test('green tags match the Next/Previous success palette without white hover text', () => {
  assert.ok(palette.includes("'green'"));
  const tag = css.match(/\.subject-tag-green \{([^}]+)\}/)[1];
  const navigation = css.match(
    /\.app-button-success,\s*\.issue-view-action \{([^}]+)\}/
  )[1];
  for (const token of [
    'border-green-500/90',
    'bg-green-950/35',
    'text-green-300',
    'hover:bg-green-900/55',
  ]) {
    assert.ok(tag.includes(token));
    assert.ok(navigation.includes(token));
  }
  assert.ok(!tag.includes('text-white'));
});

test('every subject-tag card uses the shared palette without hardcoded tag colors', () => {
  for (const file of [
    'MovieDetails/MovieDetailsLayout.tsx',
    'TvDetails/SeriesDetailsLayout.tsx',
    'BookDetails/BookDetailsLayout.tsx',
    'MusicDetails/MusicDetailsLayout.tsx',
    'CollectionDetails/CollectionMetadataDisclosures.tsx',
  ]) {
    const source = readFileSync(
      new URL(`../components/${file}`, import.meta.url),
      'utf8'
    );
    assert.match(source, /className=\{subjectTagClassName\(index\)\}/);
    assert.doesNotMatch(source, /border-\w+-400\/80 bg-\w+-500\/20/);
  }
});

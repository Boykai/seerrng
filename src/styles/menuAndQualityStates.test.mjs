import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const css = read('./globals.css');

test('menu hover, selected and selected-hover use diagonal blue gradients', () => {
  assert.match(
    css,
    /\.sidebar-link-idle:hover,[\s\S]*?linear-gradient\(40deg, #09182f 0%, #1c4b80 100%\)/
  );
  assert.match(
    css,
    /\.sidebar-link-selected\s*\{[^}]*linear-gradient\(40deg, #102d61 0%, #387ebe 100%\)/
  );
  assert.match(
    css,
    /\.sidebar-link-selected:hover,[\s\S]*?linear-gradient\(40deg, #19457f 0%, #4c98d3 100%\)/
  );
  assert.match(
    css,
    /\.main-menu-link:focus-visible\s*\{[^}]*outline: 2px solid/
  );
  for (const file of ['Sidebar', 'MobileMenu']) {
    const source = read(`../components/Layout/${file}/index.tsx`);
    assert.match(source, /main-menu-link/);
    assert.match(source, /sidebar-link-selected/);
    assert.match(source, /sidebar-link-idle/);
    assert.doesNotMatch(source, /hover:from-indigo-500 hover:to-purple-500/);
  }
});

test('request dialogs share grey disabled styling', () => {
  for (const media of ['Movie', 'Tv', 'Book', 'Music']) {
    const source = read(`../components/RequestModal/${media}RequestModal.tsx`);
    assert.match(source, /request-submit-control/);
    assert.match(source, /selectedDestinationCovered/);
  }
  assert.match(
    css,
    /\.request-submit-control:disabled\s*\{[^}]*border-gray-600 bg-gray-900 text-gray-500/
  );
});

test('all quality layouts disable unavailable formats and book/music requests cannot override availability', () => {
  for (const file of [
    'MovieDetails/MovieDetailsLayout.tsx',
    'TvDetails/SeriesDetailsLayout.tsx',
  ]) {
    const source = read(`../components/${file}`);
    assert.match(source, /disabled: !availableFormats.includes\('HD'\)/);
    assert.match(source, /disabled: !availableFormats.includes\('4K'\)/);
  }
  const music = read('../components/MusicDetails/MusicDetailsLayout.tsx');
  assert.match(music, /disabled: !qualityAvailability\[0\].available/);
  assert.match(music, /disabled: !qualityAvailability\[1\].available/);
  const book = read('../components/BookDetails/index.tsx');
  assert.match(book, /!destinationAvailable\('ebook', ebookDestination\)/);
  assert.match(
    book,
    /!destinationAvailable\('audiobook', audiobookDestination\)/
  );
  assert.match(
    read('../components/MusicDetails/index.tsx'),
    /!!available \|\|\s*\(!canChooseAlternateTarget && requested\)/
  );
});

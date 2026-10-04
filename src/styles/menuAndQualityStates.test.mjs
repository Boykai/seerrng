import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { styleContract } from './cssContract.mjs';

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

test('request dialogs use shared semantic action controls and the global disabled state', () => {
  for (const media of ['Movie', 'Tv', 'Book', 'Music']) {
    const source = read(`../components/RequestModal/${media}RequestModal.tsx`);
    assert.match(source, /selectedDestinationCovered/);
    const tag = media === 'Tv' ? 'Button' : 'button';
    const actions = [
      ...source.matchAll(new RegExp(`<${tag}\\b([\\s\\S]*?)<\\/${tag}>`, 'g')),
    ];
    const submit = actions.find(([, body]) =>
      body.includes('data-testid="modal-ok-button"')
    )?.[1];
    assert.ok(submit, `Missing request submit action: ${media}`);
    if (media === 'Tv') {
      assert.match(submit, /buttonType="success"/);
      assert.match(submit, /buttonSize="standard"/);
      assert.match(submit, /disabled=\{requestDisabled\}/);
      assert.match(submit, /onClick=\{\(\) => void submitAction\(\)\}/);
    } else {
      const roles = submit.match(/className="([^"]+)"/)?.[1].split(/\s+/);
      for (const role of [
        'app-button',
        'app-button-success',
        'button-standard',
      ]) {
        assert.ok(
          roles?.includes(role),
          `Missing shared request role: ${media} ${role}`
        );
      }
      assert.match(submit, /disabled=\{[^}]*selectedDestinationCovered/s);
      assert.match(submit, /onClick=\{\(\) => void sendRequest\(\)\}/);
    }
  }
  const button = read('../components/Common/Button/index.tsx');
  assert.match(button, /success: 'app-button-success'/);
  assert.match(button, /standard: 'button-standard'/);
  const contract = styleContract(css);
  assert.equal(contract.declaration('.app-button:disabled', 'opacity'), '0.6');
  assert.equal(
    contract.declaration('.app-button:disabled', 'cursor'),
    'not-allowed'
  );
  assert.equal(
    contract.declaration('button.app-button:disabled', 'text-shadow'),
    'none'
  );
  assert.equal(
    contract.declaration('button.app-button:disabled svg', 'filter'),
    'none'
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

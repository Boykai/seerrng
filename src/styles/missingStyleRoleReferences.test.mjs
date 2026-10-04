import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relative) =>
  readFileSync(new URL(`../components/${relative}`, import.meta.url), 'utf8');
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

test('Ordinary Discover and Association wrappers do not opt into legacy Lab-only responsive poster geometry', () => {
  for (const relative of ['Discover/index.tsx', 'Association/index.tsx']) {
    assert.doesNotMatch(
      source(relative),
      /className=["'][^"']*\bdiscover-home\b/
    );
  }
  assert.doesNotMatch(css, /\.discover-home\b/);
});

test('Expanded filter panels retain their real shared attribute-qualified style ownership', () => {
  const filters = source('Discover/FilterPanel/index.tsx');
  assert.match(
    filters,
    /className="app-card-inset app-filter-panel scrollable-card"\s+data-filter-layout="expanded"/
  );
  assert.match(
    css,
    /\.app-filter-panel\[data-filter-layout='expanded'\]\s*\{[^}]*margin-top:\s*var\(--card-spacing\)/s
  );
  assert.match(
    filters,
    /className="app-filter-panel"\s+data-filter-layout=\{variant === 'search' \? 'contents' : undefined\}/
  );
});

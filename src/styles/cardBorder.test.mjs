import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const titleCard = readFileSync(
  new URL('../components/TitleCard/index.tsx', import.meta.url),
  'utf8'
);
const requestCard = readFileSync(
  new URL('../components/RequestCard/index.tsx', import.meta.url),
  'utf8'
);
const login = readFileSync(
  new URL('../components/Login/index.tsx', import.meta.url),
  'utf8'
);

test('title cards use the two-pixel solid blue frame', () => {
  const block = css.match(/\.app-card-poster\s*\{([\s\S]*?)\n\s*\}/)?.[1];

  assert.ok(block);
  assert.match(block, /--app-card-frame-width:\s*2px/);
  assert.match(block, /border:\s*var\(--app-card-frame-width\)/);
  assert.match(css, /\.app-card-poster,[\s\S]*?\.app-card-inset/);
  assert.match(
    css,
    /--app-card-frame-background:\s*var\(--palette-blue,\s*#0051d4\)/
  );
  assert.doesNotMatch(
    css,
    /--app-card-frame-background:\s*(?:conic|linear)-gradient\(/
  );
  assert.doesNotMatch(
    css,
    /brushed-steel-conical-gradient-full-bleed-4096x4096\.png/
  );
  assert.match(titleCard, /app-card-poster/);
  assert.match(titleCard, /app-card-poster-interactive/);
  assert.match(titleCard, /app-card-poster-active/);
  assert.match(css, /\.app-card-poster-active\s*\{/);
  assert.match(css, /transform:\s*translateZ\(0\) scale\(1\.05\)/);
  assert.match(css, /\.slider-item:has\(\.app-card-poster-active\)/);
  assert.doesNotMatch(titleCard, /aspect-\[2\/3\][^\n]*ring-1/);
});

test('embedded detail posters use the same CSS frame at one pixel', () => {
  assert.match(
    css,
    /:is\(\.collection-summary-poster, \.detail-card-poster\)\s*\{[\s\S]*?--app-card-frame-width:\s*1px/
  );
  assert.match(
    css,
    /:is\(\.collection-summary-poster, \.detail-card-poster\)[\s\S]*?var\(--app-card-frame-background\) border-box/
  );
  assert.match(css, /\.app-card-poster,[\s\S]*?\.collection-summary-poster/);
});

test('the solid blue frame covers shared content card surfaces', () => {
  assert.match(css, /\.app-card-main/);
  assert.match(css, /\.app-card-sub/);
  assert.match(css, /\.app-card-inset/);
  assert.match(css, /background:\s*var\(--app-card-frame-background\)/);
  assert.match(css, /mask-composite:\s*exclude/);
  assert.match(css, /--tw-ring-shadow:\s*0 0 #0000 !important/);
  assert.match(
    css,
    /\.app-card-inset\s*\)\s*,\s*\.manage-media-card-sections > div\s*\{[\s\S]*?border-width:\s*0 !important;/
  );
  assert.match(
    css,
    /\.app-card-inset\)::after,\s*\.manage-media-card-sections > div::after\s*\{/
  );
  assert.doesNotMatch(css, /--app-card-frame-(?:top|right|bottom|left):/);
  assert.doesNotMatch(css, /--app-card-surface-background/);
  assert.doesNotMatch(
    css,
    /var\(--app-card-frame-background\) border-box !important/
  );
  assert.match(requestCard, /app-card-main/);
  assert.doesNotMatch(requestCard, /request-card-surface/);
  assert.doesNotMatch(requestCard, /request-card-brushed-steel-frame/);
});

test('sub and inset cards share the solid blue frame at one pixel', () => {
  assert.doesNotMatch(css, /blue-violet-conical-gradient-card-border\.png/);
  assert.match(
    css,
    /:is\(\.app-card-sub, \.app-card-inset\),\s*\.manage-media-card-sections > div\s*\{[\s\S]*?--app-card-frame-width:\s*1px/
  );
});

test('the login panel uses the shared main-card treatment', () => {
  assert.match(
    login,
    /auth-frosted-surface app-card-main refreshed-card-surface/
  );
  assert.doesNotMatch(
    login.match(/auth-frosted-surface[^"\n]*/)?.[0] ?? '',
    /bg-gray-800\/50/
  );
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

test('quality icons, ratings and playback logos share the 14px content height', () => {
  assert.match(
    css,
    /--action-control-content-height: calc\(var\(--action-control-height\) - 2px\);/
  );
  for (const selector of [
    '.format-request-label svg',
    '.media-rating-icon',
    '.media-rating-icon-audience',
    '.media-rating-wordmark',
    '.media-rating-value',
    '.media-rating-brand',
    '.button-standard svg.playback-provider-icon',
  ]) {
    const start = css.indexOf(selector + ' {');
    assert.ok(start > -1, selector);
    const rule = css.slice(start, css.indexOf('}', start));
    assert.ok(
      rule.includes('height: var(--action-control-content-height)'),
      selector
    );
  }
  assert.match(css, /\.media-rating-wordmark\s*\{\s*@apply w-auto/);
  assert.match(
    css,
    /\.format-request-control\s*\{[^}]*line-height: var\(--action-control-content-height\)/
  );
});

test('disabled playback retains its border and uses shared disabled styling', () => {
  assert.match(
    css,
    /\.app-button-playback\s*\{\s*@apply border-gray-500 bg-black\/35[^}]*hover:bg-black\/55[^}]*active:bg-black\/70/
  );
  assert.doesNotMatch(css, /\.app-button-playback:disabled/);
  assert.match(css, /\.app-button\s*\{[^}]*disabled:opacity-60/s);
  assert.match(
    css,
    /\.app-button\[aria-haspopup\]:not\(\.playback-dropdown-trigger\)/
  );
});

test('shared Quality and Request icons do not override global sizing with local utilities', () => {
  for (const file of [
    'MediaDetails/MediaQualitySelect.tsx',
    'Common/FormatRequestControl/index.tsx',
  ]) {
    const source = readFileSync(
      new URL(`../components/${file}`, import.meta.url),
      'utf8'
    );
    assert.doesNotMatch(source, /className="h-4 w-4"/);
  }
});

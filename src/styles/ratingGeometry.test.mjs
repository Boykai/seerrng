import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
test('rating links use action height while images and values use the shared content height', () => {
  for (const name of [
    'media-rating-link',
    'media-rating-icon',
    'media-rating-icon-audience',
    'media-rating-wordmark',
    'media-rating-value',
    'media-rating-brand',
  ]) {
    const body = css.match(new RegExp('\\.' + name + '\\s*\\{([^}]+)'))?.[1];
    assert.ok(body, name);
    assert.match(
      body,
      name === 'media-rating-link'
        ? /height: var\(--action-control-height\);/
        : /height: var\(--action-control-content-height\);/
    );
    assert.doesNotMatch(body, /\bh-(?:3\.5|4|5|6|\[30px\])/);
  }
  assert.match(css, /\.media-rating-link\s*\{[^}]*text-xs/);
  assert.match(
    css,
    /\.media-rating-row\s*\{[^}]*padding-top: var\(--card-spacing\)/
  );
});
test('media quality shares segmented request styling and action height', () => {
  const source = readFileSync(
    new URL(
      '../components/MediaDetails/MediaQualitySelect.tsx',
      import.meta.url
    ),
    'utf8'
  );
  assert.match(source, /<FormatRequestControl/);
  assert.doesNotMatch(source, /Listbox|ChevronDownIcon/);
  assert.match(
    css,
    /\.format-request-control\s*\{[^}]*height: var\(--action-control-height\)/
  );
  assert.match(css, /\.format-request-option\[aria-pressed='true'\]/);
});

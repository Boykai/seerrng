import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

test('shared Quality and Request labels match the standard green button text', () => {
  const label = css.match(/\.format-request-label \{([^}]+)\}/)[1];
  const success = css.match(
    /\.app-button-success,\s*\.issue-view-action \{([^}]+)\}/
  )[1];
  assert.ok(label.includes('text-green-300'));
  assert.ok(success.includes('text-green-300'));
  assert.ok(!label.includes('text-white'));
});

test('unavailable format options retain their grey disabled styling', () => {
  const option = css.match(/\.format-request-option \{([^}]+)\}/)[1];
  assert.ok(option.includes('disabled:text-gray-500'));
  assert.ok(option.includes('disabled:grayscale'));
});

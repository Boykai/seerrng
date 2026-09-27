import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
test('shared summary titles compensate for font bearing without changing layout spacing', () => {
  const rule = css.match(
    /\.detail-summary-title,\s*\.collection-summary-title,\s*\.movie-summary-title\s*\{([^}]+)\}/
  )?.[1];
  assert.match(rule, /position: relative;/);
  assert.match(rule, /top: -2px;/);
  assert.doesNotMatch(rule, /margin|padding/);
  const titleRule = css.match(/\.movie-summary-title\s*\{([^}]+)\}/)?.[1];
  for (const token of [
    'items-start',
    'text-lg',
    'font-semibold',
    'leading-5',
  ]) {
    assert.ok(titleRule?.includes(token), `Missing title utility: ${token}`);
  }
});

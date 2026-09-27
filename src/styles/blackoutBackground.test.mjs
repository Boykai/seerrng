import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
test('only Blackout disables the corner spotlight and retains its blue gradient', () => {
  const root = css.match(/:root\s*\{([^}]+)/)?.[1];
  const blackout = css.match(
    /\[data-theme-palette='blackout'\]\s*\{([^}]+)/
  )?.[1];
  assert.match(root, /--theme-page-spotlight-strength: 1;/);
  assert.match(blackout, /--theme-page-spotlight-strength: 0;/);
  assert.doesNotMatch(blackout, /--theme-page-spotlight-(center|edge):/);
  for (const stop of [
    'light: 40 68 120',
    'main: 26 50 96',
    'deep: 14 28 58',
    'black: 0 0 0',
  ]) {
    assert.ok(blackout.includes('--theme-page-gradient-' + stop), stop);
  }
  assert.equal(
    (css.match(/--theme-page-spotlight-strength: 0;/g) || []).length,
    1
  );
});
test('every shared background spotlight honors the palette strength', () => {
  const stops =
    css.match(
      /rgb\(\s*var\(--theme-page-spotlight-(?:center|edge)\)[\s\S]*?\)\s+(?:0|34)%/g
    ) || [];
  assert.equal(stops.length, 12);
  for (const stop of stops)
    assert.ok(stop.includes('var(--theme-page-spotlight-strength)'), stop);
  assert.match(css, /rgb\(var\(--theme-page-gradient-black\) \/ 0\.8\) 0%/);
});

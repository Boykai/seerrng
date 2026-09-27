import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL(
    '../components/Discover/FilterPanel/CompactFilterSelect.tsx',
    import.meta.url
  ),
  'utf8'
);
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

test('filter and rating menus scroll after eight uniform rows', () => {
  const menu = css.match(/\.app-filter-select-menu\s*\{([^}]+)\}/)?.[1];
  const option = css.match(/\.app-filter-select-option\s*\{([^}]+)\}/)?.[1];
  assert.ok(menu);
  assert.ok(option);
  assert.match(menu, /--filter-option-height: 1\.5rem/);
  assert.match(
    menu,
    /--anchor-max-height: calc\(8 \* var\(--filter-option-height\) \+ 0\.5rem \+ 2px\)/
  );
  assert.match(menu, /max-height: var\(--anchor-max-height\)/);
  assert.match(menu, /overflow-auto/);
  assert.match(option, /height: var\(--filter-option-height\)/);
  assert.doesNotMatch(
    css,
    /\.app-filter-rating-menu\s*\{[^}]*(?:max-height: none|overflow: hidden)/
  );
});

test('both compact menus escape clipping through an anchored portal', () => {
  const menus = [...source.matchAll(/<Listbox.Options\b[\s\S]*?>/g)];
  assert.equal(menus.length, 2);
  for (const [menu] of menus) {
    assert.match(menu, /anchor="bottom start"/);
    assert.match(menu, /\bportal\b/);
    assert.match(menu, /modal=\{false\}/);
    assert.match(menu, /app-filter-select-menu-floating/);
  }
});

test('portal sizing follows the trigger rather than the full document width', () => {
  const rule = css.match(
    /\.app-filter-select-menu-floating\s*\{([^}]+)\}/
  )?.[1];
  assert.ok(rule);
  assert.match(rule, /min-width: var\(--button-width\)/);
  assert.match(rule, /--anchor-padding: 8px/);
  assert.match(rule, /margin-top: 0/);
});

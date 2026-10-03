import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import { styleContract } from './cssContract.mjs';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const themeContext = readFileSync(
  new URL('../context/ThemeContext.tsx', import.meta.url),
  'utf8'
);
const assertBlackoutBackground = (stylesheet) => {
  // Blackout is the chrome family; its persisted/runtime palette identifier is seerr.
  const palettes = [
    ...themeContext.matchAll(/\{\s*id: '([^']+)',([^{}]*?)\},/g),
  ];
  const blackout = palettes.filter(([, , body]) =>
    body.includes("chrome: 'blackout'")
  );
  assert.deepEqual(
    blackout.map(([, id]) => id),
    ['seerr']
  );
  assert.match(
    themeContext,
    /document\.documentElement\.dataset\.themePalette = themeTokens\.activePaletteId/
  );
  const palette = "[data-theme-palette='seerr']";
  const contract = styleContract(stylesheet);
  assert.equal(
    contract.declaration(':root', '--theme-page-spotlight-strength'),
    '1'
  );
  assert.equal(
    contract.declaration(palette, '--theme-page-spotlight-strength'),
    '0'
  );
  for (const property of ['center', 'edge'])
    assert.equal(
      contract.declaration(palette, '--theme-page-spotlight-' + property),
      undefined
    );
  for (const [stop, value] of Object.entries({
    light: '0 0 0',
    main: '40 68 120',
    deep: '14 28 58',
    black: '0 0 0',
  })) {
    assert.equal(
      contract.declaration(palette, '--theme-page-gradient-' + stop),
      value
    );
  }
  assert.equal(
    contract.declaration(palette, '--theme-page-gradient-main-stop'),
    '50%'
  );
  const disabledSpotlights = [];
  postcss
    .parse(stylesheet)
    .walkDecls('--theme-page-spotlight-strength', (decl) => {
      if (decl.value === '0') disabledSpotlights.push(...decl.parent.selectors);
    });
  assert.deepEqual(disabledSpotlights, [palette]);
};

test('only the runtime Blackout palette disables the spotlight and retains its blue gradient', () => {
  assertBlackoutBackground(css);
});

test('Blackout check rejects a spotlight override leaked into another palette', () => {
  assert.throws(
    () =>
      assertBlackoutBackground(
        css +
          "\n[data-theme-palette='classic'] { --theme-page-spotlight-strength: 0; }"
      ),
    assert.AssertionError
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

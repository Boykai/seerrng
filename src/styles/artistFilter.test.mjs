import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
test('artist control and popup retain a readable width without overflowing small screens', () => {
  const rule = (suffix = '') =>
    css.match(
      new RegExp(
        '\\.discover-filter-control\\.music-artist-filter' +
          suffix +
          '\\s*\\{([^}]+)\\}'
      )
    )?.[1];
  assert.match(rule(), /width: 20rem;/);
  assert.match(rule(), /max-width: 100%;/);
  assert.match(rule(' \\.react-select-container'), /flex: 1 1 0%;/);
  assert.match(rule(' \\.react-select-container'), /min-width: 0;/);
  assert.match(
    rule('\\s+\\.discover-compact-select\\s+\\.react-select__menu'),
    /width: 100%;/
  );
});
